//! Trace Helper — правила и законы Trace RP поверх игры по горячей клавише.
//!
//! Тексты берутся с форума: встроенное окно форума (обычный WebView2, пользователь сам
//! проходит проверку браузера) передаёт сюда темы через forum.js.

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, Webview, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

type Res<T> = Result<T, String>;

const FORUM_DEFAULT: &str = "https://forum.trace-rp.com/";

/// Отладка без окон на экране (FH_HEADLESS=1).
fn headless() -> bool {
    cfg!(debug_assertions) && std::env::var("FH_HEADLESS").is_ok()
}

/// Адрес форума. В отладочной сборке можно подменить через FH_FORUM для теста на копии.
fn forum() -> &'static str {
    static F: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    F.get_or_init(|| {
        if cfg!(debug_assertions) {
            if let Ok(f) = std::env::var("FH_FORUM") {
                return f;
            }
        }
        FORUM_DEFAULT.to_string()
    })
}
const FORUM_JS: &str = include_str!("forum.js");

/// Общая база правил и законов: копия внутри программы + свежая версия с GitHub.
const BASE_JSON: &str = include_str!("../base.json");
const BASE_URL: &str = "https://github.com/demidsev3-byte/TraceHelper/releases/download/base/base.json";

/// Темы законов штата на форуме Trace RP (номера тем).
const LAW_THREADS: &[&str] = &[
    "11067", "10096", "11068", "10782", "10781", "8114", "10107", "11453", "11034", "11053", "10765",
    "11666", "10101", "10780", "7316", "10763", "11665", "11664", "10764", "10106", "10760",
];
const MAX_QUEUE: usize = 600;

/// Закреплено: окно висит поверх игры, а управление остаётся в игре.
static PINNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Окно, которое было активным до хелпера (обычно игра) — ему возвращаем фокус.
static PREV_FG: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

// ---------- данные ----------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Doc {
    id: String,
    title: String,
    url: String,
    section: String,
    text: String,
    #[serde(default)]
    prev_text: Option<String>,
    fetched_at: u64,
    #[serde(default)]
    changed_at: Option<u64>,
    /// версия общей базы, из которой взят текст (fetched_at в base.json)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Default)]
struct Library {
    docs: Vec<Doc>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    hotkey: String,
    always_on_top: bool,
    streamer_mode: bool,
    hide_on_blur: bool,
    copy_on_click: bool,
    /// ставить обновления самому (выключено — только кнопка «Обновить»)
    auto_update: bool,
    /// Ctrl+Пробел в игре: сказать голосом, справа покажется статья
    voice_overlay: bool,
    /// размер окна: 1.0 — обычный, 0.7…1.5
    scale: f64,
    /// показывать плашку промокода в строке
    show_promo: bool,
    /// подпись автора под строкой
    show_credit: bool,
    /// версия настроек: 1 — автообновление выключено у всех, включает сам пользователь
    #[serde(default)]
    rev: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: "Alt+Q".into(),
            always_on_top: true,
            streamer_mode: false,
            hide_on_blur: false,
            copy_on_click: true,
            auto_update: false,
            voice_overlay: true,
            scale: 1.0,
            show_promo: true,
            show_credit: true,
            rev: 1,
        }
    }
}

#[derive(Deserialize, Clone)]
struct QItem {
    url: String,
    kind: String,
}

#[derive(Default)]
struct Crawl {
    active: bool,
    done: bool,
    queue: VecDeque<QItem>,
    seen: HashSet<String>,
    current: Option<QItem>,
    saved_now: usize,
}

struct AppState {
    lib: Mutex<Library>,
    settings: Mutex<Settings>,
    crawl: Mutex<Crawl>,
}

/// "ЗакрытоПравила форума" -> "Правила форума": статусы тем XenForo прилипают к названию.
fn clean_title(t: &str) -> String {
    let mut s = t.trim();
    loop {
        let before = s;
        for p in ["Закрыто", "Закреплено", "Важно", "Решено", "Открыто", "Актуально"] {
            if let Some(rest) = s.strip_prefix(p) {
                s = rest.trim_start();
            }
        }
        if s == before {
            return s.to_string();
        }
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn data_dir(app: &AppHandle) -> PathBuf {
    let d = app.path().app_data_dir().expect("app data dir");
    fs::create_dir_all(&d).ok();
    d
}

fn load<T: for<'a> Deserialize<'a> + Default>(app: &AppHandle, name: &str) -> T {
    fs::read_to_string(data_dir(app).join(name))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save<T: Serialize>(app: &AppHandle, name: &str, v: &T) -> Res<()> {
    let dir = data_dir(app);
    let tmp = dir.join(format!("{name}.tmp"));
    fs::write(&tmp, serde_json::to_vec(v).unwrap()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join(name)).map_err(|e| e.to_string())
}

/// "https://forum.trace-rp.com/threads/zakon.123/page-2" -> "123"
fn thread_id(url: &str) -> Option<String> {
    let rest = url.split("/threads/").nth(1)?;
    let seg = rest.split(['/', '?', '#']).next()?;
    let id = seg.rsplit('.').next()?;
    id.chars().all(|c| c.is_ascii_digit()).then(|| id.to_string()).filter(|s| !s.is_empty())
}

fn queue_key(it: &QItem) -> String {
    match (it.kind.as_str(), thread_id(&it.url)) {
        ("thread", Some(id)) => format!("t{id}"),
        _ => format!("s{}", it.url.trim_end_matches('/')),
    }
}

fn require(webview: &Webview, label: &str) -> Res<()> {
    if cfg!(debug_assertions) {
        eprintln!("[ipc] from {} need {}", webview.label(), label);
    }
    if webview.label() == label {
        Ok(())
    } else {
        Err("Команда недоступна из этого окна".into())
    }
}

/// Вливает общую базу в свою: новые документы добавляет, изменённые в базе — обновляет
/// (старый текст уходит в «изменения»). Сверяем с версией базы, а не с датой своей копии:
/// иначе документ, который ты сам скачал с форума позже, навсегда перестаёт обновляться.
fn merge_base(lib: &mut Library, base: Library) -> bool {
    let mut changed = false;
    for b in base.docs {
        if b.text.trim().is_empty() {
            continue;
        }
        let ver = Some(b.fetched_at);
        match lib.docs.iter_mut().find(|d| d.id == b.id) {
            None => {
                lib.docs.push(Doc { prev_text: None, changed_at: None, base_at: ver, title: clean_title(&b.title), ..b });
                changed = true;
            }
            // копия из версии до 1.7.1 (версия базы не записана) и не старше базы — просто запоминаем версию
            Some(d) if d.base_at.is_none() && d.fetched_at >= b.fetched_at => {
                d.base_at = ver;
                changed = true;
            }
            Some(d) if d.base_at != ver => {
                if d.text != b.text {
                    d.prev_text = Some(std::mem::take(&mut d.text));
                    d.changed_at = Some(b.fetched_at);
                    d.text = b.text;
                }
                d.title = clean_title(&b.title);
                d.section = b.section;
                d.url = b.url;
                d.fetched_at = d.fetched_at.max(b.fetched_at);
                d.base_at = ver;
                changed = true;
            }
            _ => {}
        }
    }
    changed
}

/// Раз в час скачивает общую базу с GitHub и вливает в свою.
fn spawn_base_sync(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio_sleep(std::time::Duration::from_secs(5)).await;
        loop {
            if let Ok(r) = reqwest::get(BASE_URL).await {
                if r.status().is_success() {
                    if let Ok(bytes) = r.bytes().await {
                        if let Ok(base) = serde_json::from_slice::<Library>(&bytes) {
                            let st = app.state::<AppState>();
                            let mut lib = st.lib.lock().unwrap();
                            if merge_base(&mut lib, base) {
                                let _ = save(&app, "library.json", &*lib);
                                drop(lib);
                                let _ = app.emit("docs-updated", ());
                            }
                        }
                    }
                }
            }
            tokio_sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
}

// ---------- окно ----------

const BAR_W: f64 = 1100.0;
const BAR_H: f64 = 155.0; // строка поиска + вкладка с подписью снизу + место под тень
const PANEL_H: f64 = 620.0;

/// Текущий размер окна (масштаб) и раскрыта ли панель — чтобы пересчитать размер при смене масштаба.
static SCALE_BITS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0x3FF0_0000_0000_0000); // 1.0
static EXPANDED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn scale() -> f64 {
    f64::from_bits(SCALE_BITS.load(std::sync::atomic::Ordering::SeqCst))
}
fn resize_main(w: &tauri::WebviewWindow) -> Res<()> {
    let k = scale();
    let h = if EXPANDED.load(std::sync::atomic::Ordering::SeqCst) { BAR_H + PANEL_H } else { BAR_H };
    w.set_size(tauri::LogicalSize::new(BAR_W * k, h * k)).map_err(|e| e.to_string())
}

/// Ставит строку при первом показе: туда, куда её передвинули в прошлый раз,
/// а если места ещё нет (или тот монитор отключён) — по центру сверху, как у Spotlight.
fn place_bar(w: &tauri::WebviewWindow) {
    static PLACED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if PLACED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let saved: Option<(i32, i32)> = fs::read_to_string(data_dir(w.app_handle()).join("pos.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    if let Some((x, y)) = saved {
        let on_screen = w.available_monitors().unwrap_or_default().iter().any(|m| {
            let (p, sz) = (m.position(), m.size());
            x >= p.x - 50 && y >= p.y - 50 && x < p.x + sz.width as i32 - 100 && y < p.y + sz.height as i32 - 60
        });
        if on_screen {
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
            return;
        }
    }
    if let Ok(Some(m)) = w.primary_monitor() {
        let scale = m.scale_factor();
        let size = m.size().to_logical::<f64>(scale);
        let pos = m.position().to_logical::<f64>(scale);
        let x = pos.x + (size.width - BAR_W * self::scale()) / 2.0;
        let y = pos.y + size.height * 0.1;
        let _ = w.set_position(tauri::LogicalPosition::new(x, y));
    }
}

/// Запоминает, куда передвинули строку. Пишет на диск, когда перетаскивание закончилось
/// (через полсекунды без новых сдвигов), а не на каждый пиксель.
fn remember_pos(app: &AppHandle, x: i32, y: i32) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static GEN: AtomicU64 = AtomicU64::new(0);
    let g = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if GEN.load(Ordering::SeqCst) == g {
            let _ = fs::write(data_dir(&app).join("pos.json"), format!("[{x},{y}]"));
        }
    });
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        place_bar(&w);
        let _ = w.unminimize();
        let _ = w.show();
        // по горячей клавише окно всегда встаёт поверх всего, в том числе поверх игры
        let _ = w.set_always_on_top(true);
        #[cfg(windows)]
        if let Ok(h) = w.hwnd() {
            force_front(h.0 as isize);
        }
        let _ = w.set_focus();
        let _ = w.emit("focus-search", ());
    }
}

/// Вернуть фокус игре (окну, которое было активным до хелпера). Хелпер остаётся на экране.
#[cfg(windows)]
fn focus_game() -> bool {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn SetForegroundWindow(hwnd: isize) -> i32;
        fn IsWindow(hwnd: isize) -> i32;
    }
    let prev = PREV_FG.load(std::sync::atomic::Ordering::SeqCst);
    unsafe { prev != 0 && IsWindow(prev) != 0 && SetForegroundWindow(prev) != 0 }
}
#[cfg(not(windows))]
fn focus_game() -> bool {
    false
}

/// Windows не даёт фоновой программе забрать фокус у игры. Обход: на время
/// подключаемся к потоку активного окна, поднимаем своё окно наверх и отключаемся.
#[cfg(windows)]
fn force_front(hwnd: isize) {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetForegroundWindow() -> isize;
        fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
        fn AttachThreadInput(from: u32, to: u32, attach: i32) -> i32;
        fn SetForegroundWindow(hwnd: isize) -> i32;
        fn BringWindowToTop(hwnd: isize) -> i32;
        fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentThreadId() -> u32;
    }
    const HWND_TOPMOST: isize = -1;
    const SWP_NOSIZE: u32 = 0x1;
    const SWP_NOMOVE: u32 = 0x2;
    const SWP_SHOWWINDOW: u32 = 0x40;
    unsafe {
        let fg = GetForegroundWindow();
        if fg != 0 && fg != hwnd {
            PREV_FG.store(fg, std::sync::atomic::Ordering::SeqCst);
        }
        let fg_thread = if fg != 0 { GetWindowThreadProcessId(fg, std::ptr::null_mut()) } else { 0 };
        let me = GetCurrentThreadId();
        let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, 1) != 0;
        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
        if attached {
            AttachThreadInput(me, fg_thread, 0);
        }
    }
}

/// Зажата ли левая кнопка мыши (идёт перетаскивание окна).
#[cfg(windows)]
fn mouse_down() -> bool {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetAsyncKeyState(key: i32) -> i16;
    }
    unsafe { GetAsyncKeyState(0x01) < 0 }
}
#[cfg(not(windows))]
fn mouse_down() -> bool {
    false
}

fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // окно всегда поверх всего, поэтому «видно» = «на экране»: Alt+Q прячет его,
        // даже если фокус уже ушёл обратно в игру
        let visible = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false);
        if visible && PINNED.load(std::sync::atomic::Ordering::SeqCst) {
            // закреплено: Alt+Q переключает управление между хелпером и игрой, окно не прячется
            if w.is_focused().unwrap_or(false) {
                focus_game();
            } else {
                show_main(app);
            }
        } else if visible {
            let _ = w.hide();
            hide_history(app);
        } else {
            show_main(app);
        }
    }
}

fn apply_window_settings(app: &AppHandle, s: &Settings) {
    if let Some(w) = app.get_webview_window("main") {
        let k = if s.scale.is_finite() { s.scale.clamp(0.7, 1.5) } else { 1.0 };
        SCALE_BITS.store(k.to_bits(), std::sync::atomic::Ordering::SeqCst);
        let _ = w.set_zoom(k);
        let _ = resize_main(&w);
        let _ = w.set_always_on_top(s.always_on_top);
        // режим стримера: окно не видно в OBS, Discord и на скриншотах
        let _ = w.set_content_protected(s.streamer_mode);
    }
    if let Some(w) = app.get_webview_window("voice") {
        let _ = w.set_content_protected(s.streamer_mode);
    }
    if let Some(w) = app.get_webview_window("history") {
        let _ = w.set_content_protected(s.streamer_mode);
        if w.is_visible().unwrap_or(false) {
            place_history(app);
        }
    }
}

const VOICE_KEY: &str = "Ctrl+Space";
/// id сочетания голосового ввода (0 — выключено)
static VOICE_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Главное сочетание (Alt+Q) и, если включено, Ctrl+Пробел для голоса.
fn register_hotkeys(app: &AppHandle, s: &Settings) -> Res<()> {
    let hotkey = &s.hotkey;
    let sc: Shortcut = hotkey.parse().map_err(|_| format!("Непонятное сочетание: {hotkey}"))?;
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    VOICE_ID.store(0, std::sync::atomic::Ordering::SeqCst);
    gs.register(sc)
        .map_err(|_| format!("Сочетание {hotkey} уже занято другой программой"))?;
    if s.voice_overlay {
        let v: Shortcut = VOICE_KEY.parse().map_err(|_| "Ctrl+Space".to_string())?;
        if v.id() != sc.id() {
            gs.register(v)
                .map_err(|_| "Ctrl+Пробел уже занят другой программой — голос в игре не включился".to_string())?;
            VOICE_ID.store(v.id(), std::sync::atomic::Ordering::SeqCst);
        }
    }
    Ok(())
}

// ---------- голос в игре: карточка справа ----------

const VOICE_W: f64 = 440.0;

/// Ctrl+Пробел. Хелпер открыт и в фокусе — голос как раньше, в строке поиска.
/// Иначе справа выезжает карточка, игра остаётся активной.
fn voice_hotkey(app: &AppHandle) {
    if let Some(m) = app.get_webview_window("main") {
        if m.is_visible().unwrap_or(false) && m.is_focused().unwrap_or(false) {
            let _ = app.emit_to("main", "voice-hotkey-main", ());
            return;
        }
    }
    if let Some(v) = app.get_webview_window("voice") {
        show_voice(&v);
        let _ = app.emit_to("voice", "voice-hotkey-card", ());
    }
}

fn make_voice_window(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("voice").is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "voice", WebviewUrl::App("index.html".into()))
        .title("Trace Helper — голос")
        .inner_size(VOICE_W, 160.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()?;
    Ok(())
}

// ---------- окно истории справа от хелпера ----------
const HIST_W: f64 = 400.0;

fn make_history_window(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("history").is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "history", WebviewUrl::App("index.html".into()))
        .title("Trace Helper — история")
        .inner_size(HIST_W, 560.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build()?;
    Ok(())
}

/// Ставит окно истории вплотную справа от рамки хелпера (не влезает — слева).
fn place_history(app: &AppHandle) {
    let (Some(main), Some(h)) = (app.get_webview_window("main"), app.get_webview_window("history")) else { return };
    let (Ok(pos), Ok(size)) = (main.outer_position(), main.outer_size()) else { return };
    let sf = main.scale_factor().unwrap_or(1.0);
    let k = scale();
    let (mx, my, mw) = (pos.x as f64 / sf, pos.y as f64 / sf, size.width as f64 / sf);
    let w = HIST_W * k;
    let hgt = (BAR_H + PANEL_H - 43.0) * k;
    let mut x = mx + mw - 9.0 * k + 8.0;
    if let Some(m) = main.current_monitor().ok().flatten() {
        let ms = m.scale_factor();
        let right = m.position().to_logical::<f64>(ms).x + m.size().to_logical::<f64>(ms).width;
        if x + w > right {
            x = mx + 9.0 * k - 8.0 - w;
        }
    }
    let _ = h.set_zoom(k);
    let _ = h.set_size(tauri::LogicalSize::new(w, hgt));
    let _ = h.set_position(tauri::LogicalPosition::new(x, my + 37.0 * k));
}

fn hide_history(app: &AppHandle) {
    if let Some(h) = app.get_webview_window("history") {
        let _ = h.hide();
    }
}

/// Фокус ушёл из хелпера или истории: если включено «прятать» и окно не закреплено —
/// прячем оба окна, но только если фокус не перешёл между ними и кнопка мыши отпущена (перетаскивание).
fn blur_check(app: &AppHandle) {
    let hide = app.state::<AppState>().settings.lock().unwrap().hide_on_blur;
    if !hide || PINNED.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        while mouse_down() {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let focused = |l: &str| app.get_webview_window(l).is_some_and(|w| w.is_focused().unwrap_or(true));
        if !focused("main") && !focused("history") {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
            hide_history(&app);
        }
    });
}

/// Кнопка «История» в хелпере: открыть / закрыть окно справа.
#[tauri::command]
fn toggle_history(app: AppHandle, webview: Webview) -> Res<()> {
    require(&webview, "main")?;
    let Some(h) = app.get_webview_window("history") else { return Ok(()) };
    if h.is_visible().unwrap_or(false) {
        let _ = h.hide();
    } else {
        place_history(&app);
        let _ = h.show();
        let _ = app.emit_to("history", "history-shown", ());
    }
    Ok(())
}

#[tauri::command]
fn history_hide(app: AppHandle, webview: Webview) -> Res<()> {
    require(&webview, "history")?;
    hide_history(&app);
    Ok(())
}

/// Клик по строке истории: статья открывается в хелпере, окно истории остаётся. Пустой id — изменения в законах.
#[tauri::command]
fn history_open(app: AppHandle, webview: Webview, doc_id: String, num: String) -> Res<()> {
    require(&webview, "history")?;
    show_main(&app);
    if doc_id.is_empty() {
        let _ = app.emit_to("main", "show-changes", ());
    } else {
        let _ = app.emit_to("main", "open-point", (doc_id, num));
    }
    Ok(())
}

/// Показать карточку у правого края экрана, не забирая фокус у игры.
fn show_voice(w: &tauri::WebviewWindow) {
    let mon = w
        .app_handle()
        .get_webview_window("main")
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| w.primary_monitor().ok().flatten());
    if let Some(m) = mon {
        let scale = m.scale_factor();
        let size = m.size().to_logical::<f64>(scale);
        let pos = m.position().to_logical::<f64>(scale);
        let _ = w.set_position(tauri::LogicalPosition::new(pos.x + size.width - VOICE_W - 16.0, pos.y + 90.0));
    }
    #[cfg(windows)]
    if let Ok(h) = w.hwnd() {
        show_no_activate(h.0 as isize);
        return;
    }
    let _ = w.show();
}

#[cfg(windows)]
fn show_no_activate(hwnd: isize) {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
        fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
        fn GetWindowLongPtrW(hwnd: isize, idx: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: isize, idx: i32, v: isize) -> isize;
    }
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_NOACTIVATE: isize = 0x0800_0000;
    const SW_SHOWNOACTIVATE: i32 = 4;
    const HWND_TOPMOST: isize = -1;
    const SWP_NOSIZE: u32 = 0x1;
    const SWP_NOMOVE: u32 = 0x2;
    const SWP_NOACTIVATE: u32 = 0x10;
    unsafe {
        // окно никогда не становится активным: клик и колесо работают, а клавиатура остаётся у игры
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if ex & WS_EX_NOACTIVATE == 0 {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE);
        }
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

/// Карточка подстраивает высоту под содержимое.
#[tauri::command]
fn voice_resize(app: AppHandle, webview: Webview, height: f64) -> Res<()> {
    require(&webview, "voice")?;
    if let Some(w) = app.get_webview_window("voice") {
        w.set_size(tauri::LogicalSize::new(VOICE_W, height.clamp(60.0, 760.0)))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn voice_hide(app: AppHandle, webview: Webview) -> Res<()> {
    require(&webview, "voice")?;
    hide_voice(&app);
    Ok(())
}

/// Карточка показана мимо Tauri (без фокуса), поэтому и прятать её надо напрямую:
/// обычный hide() думает, что окно и так скрыто, и ничего не делает.
fn hide_voice(app: &AppHandle) {
    let Some(w) = app.get_webview_window("voice") else { return };
    #[cfg(windows)]
    if let Ok(h) = w.hwnd() {
        #[link(name = "user32")]
        unsafe extern "system" {
            fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
        }
        unsafe { ShowWindow(h.0 as isize, 0) }; // SW_HIDE
    }
    let _ = w.hide();
}

/// Открыть статью из карточки в большом окне хелпера.
#[tauri::command]
fn voice_open(app: AppHandle, webview: Webview, doc_id: String, num: String) -> Res<()> {
    require(&webview, "voice")?;
    hide_voice(&app);
    show_main(&app);
    let _ = app.emit_to("main", "open-point", (doc_id, num));
    Ok(())
}

fn open_forum_window(app: &AppHandle, url: &str) -> Res<()> {
    let parsed: tauri::Url = url.parse().map_err(|_| "Плохая ссылка".to_string())?;
    if let Some(w) = app.get_webview_window("forum") {
        w.navigate(parsed).map_err(|e| e.to_string())?;
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "forum", WebviewUrl::External(parsed))
        .title("Форум Trace RP — Trace Helper")
        .inner_size(1180.0, 820.0)
        .center()
        .initialization_script(FORUM_JS)
        .visible(!headless())
        .on_page_load(|_w, p| {
            if cfg!(debug_assertions) {
                eprintln!("[forum] page {:?} {}", p.event(), p.url());
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn emit_status(app: &AppHandle, c: &Crawl) {
    let _ = app.emit(
        "crawl-status",
        serde_json::json!({ "active": c.active, "left": c.queue.len(), "savedNow": c.saved_now }),
    );
}

/// Следующий адрес очереди; None — сбор закончен.
fn next_url(app: &AppHandle, c: &mut Crawl) -> Option<String> {
    c.current = c.queue.pop_front();
    let next = c.current.as_ref().map(|q| q.url.clone());
    if next.is_none() && c.active {
        c.active = false;
        c.done = true;
    }
    emit_status(app, c);
    next
}

// ---------- команды главного окна ----------

#[tauri::command]
fn get_docs(state: State<AppState>) -> Vec<Doc> {
    state.lib.lock().unwrap().docs.clone()
}

#[tauri::command]
fn delete_doc(app: AppHandle, webview: Webview, state: State<AppState>, id: String) -> Res<()> {
    require(&webview, "main")?;
    let mut lib = state.lib.lock().unwrap();
    lib.docs.retain(|d| d.id != id);
    save(&app, "library.json", &*lib)
}

#[tauri::command]
fn clear_changes(app: AppHandle, webview: Webview, state: State<AppState>) -> Res<()> {
    require(&webview, "main")?;
    let mut lib = state.lib.lock().unwrap();
    for d in &mut lib.docs {
        d.prev_text = None;
        d.changed_at = None;
    }
    save(&app, "library.json", &*lib)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    #[serde(flatten)]
    s: Settings,
    autostart: bool,
}

#[tauri::command]
fn get_settings(app: AppHandle, state: State<AppState>) -> SettingsView {
    SettingsView {
        s: state.settings.lock().unwrap().clone(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
    }
}

#[tauri::command]
fn set_settings(app: AppHandle, webview: Webview, state: State<AppState>, settings: Settings) -> Res<()> {
    require(&webview, "main")?;
    let mut cur = state.settings.lock().unwrap();
    if settings.hotkey != cur.hotkey || settings.voice_overlay != cur.voice_overlay {
        if let Err(e) = register_hotkeys(&app, &settings) {
            let _ = register_hotkeys(&app, &cur);
            return Err(e);
        }
    }
    apply_window_settings(&app, &settings);
    let rev = cur.rev;
    *cur = settings;
    cur.rev = cur.rev.max(rev); // окно не знает про версию настроек — не теряем её
    save(&app, "settings.json", &*cur)
}

#[tauri::command]
fn set_autostart(app: AppHandle, webview: Webview, on: bool) -> Res<()> {
    require(&webview, "main")?;
    let al = app.autolaunch();
    if on { al.enable() } else { al.disable() }.map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_forum(app: AppHandle, webview: Webview, url: Option<String>) -> Res<()> {
    require(&webview, "main")?;
    let url = url.filter(|u| u.starts_with(forum())).unwrap_or_else(|| forum().into());
    open_forum_window(&app, &url)
}

/// Перекачать все сохранённые темы заново (обновление законов).
#[tauri::command]
async fn sync_all(app: AppHandle, webview: Webview, state: State<'_, AppState>) -> Res<usize> {
    require(&webview, "main")?;
    let mut urls: Vec<String> = Vec::new();
    {
        let lib = state.lib.lock().unwrap();
        urls.extend(lib.docs.iter().map(|d| d.url.clone()));
        for id in LAW_THREADS {
            if !lib.docs.iter().any(|d| d.id == *id) {
                urls.push(format!("{}threads/{id}/", forum()));
            }
        }
    }
    if urls.is_empty() {
        open_forum_window(&app, forum())?;
        return Ok(0);
    }
    let first = {
        let mut c = state.crawl.lock().unwrap();
        *c = Crawl { active: true, ..Default::default() };
        for u in &urls {
            let it = QItem { url: u.clone(), kind: "thread".into() };
            c.seen.insert(queue_key(&it));
            c.queue.push_back(it);
        }
        next_url(&app, &mut c)
    };
    if let Some(u) = first {
        open_forum_window(&app, &u)?;
    }
    Ok(urls.len())
}

/// Скачать законы штата с форума: по очереди открывает их темы во встроенном окне форума.
#[tauri::command]
async fn fetch_laws(app: AppHandle, webview: Webview, state: State<'_, AppState>) -> Res<usize> {
    require(&webview, "main")?;
    let first = {
        let mut c = state.crawl.lock().unwrap();
        *c = Crawl { active: true, ..Default::default() };
        for id in LAW_THREADS {
            let it = QItem { url: format!("{}threads/{id}/", forum()), kind: "thread".into() };
            c.seen.insert(queue_key(&it));
            c.queue.push_back(it);
        }
        next_url(&app, &mut c)
    };
    if let Some(u) = first {
        open_forum_window(&app, &u)?;
    }
    Ok(LAW_THREADS.len())
}

/// Раскрыть панель с результатами под строкой поиска или свернуть обратно в строку.
#[tauri::command]
fn set_expanded(app: AppHandle, webview: Webview, expanded: bool) -> Res<()> {
    require(&webview, "main")?;
    EXPANDED.store(expanded, std::sync::atomic::Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("main") {
        resize_main(&w)?;
    }
    Ok(())
}

/// Закрепить / открепить окно. При закреплении управление сразу возвращается в игру.
#[tauri::command]
fn set_pinned(app: AppHandle, webview: Webview, pinned: bool) -> Res<()> {
    require(&webview, "main")?;
    PINNED.store(pinned, std::sync::atomic::Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(true);
    }
    if pinned {
        focus_game();
    }
    Ok(())
}

#[tauri::command]
fn hide_main(app: AppHandle) {
    if PINNED.load(std::sync::atomic::Ordering::SeqCst) {
        // закреплено: Esc не прячет окно, а возвращает управление в игру
        focus_game();
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    hide_history(&app);
}

// ---------- обновление программы ----------

/// Есть ли новая версия на GitHub. Возвращает номер версии или None.
#[tauri::command]
async fn check_update(app: AppHandle) -> Res<Option<String>> {
    use tauri_plugin_updater::UpdaterExt;
    let upd = app.updater().map_err(|e| e.to_string())?;
    Ok(upd.check().await.map_err(|e| e.to_string())?.map(|u| u.version))
}

/// Скачивает и ставит обновление, потом перезапускает программу.
#[tauri::command]
async fn install_update(app: AppHandle) -> Res<()> {
    use tauri_plugin_updater::UpdaterExt;
    let upd = app.updater().map_err(|e| e.to_string())?;
    let Some(u) = upd.check().await.map_err(|e| e.to_string())? else {
        return Err("Обновлений нет".into());
    };
    u.download_and_install(|_, _| {}, || {}).await.map_err(|e| format!("Не удалось обновиться: {e}"))?;
    app.restart();
}

/// Автообновление: через 20 секунд после запуска и потом каждые 15 минут.
/// Если окно спрятано — ставит новую версию тихо и сам перезапускается.
/// Если окно открыто — не мешает, показывает кнопку «Обновить» в строке.
fn spawn_update_checks(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_updater::UpdaterExt;
        tokio_sleep(std::time::Duration::from_secs(20)).await;
        loop {
            if let Ok(upd) = app.updater() {
                if let Ok(Some(u)) = upd.check().await {
                    // автообновление выключено — только кнопка «Обновить» в строке
                    let auto = app.state::<AppState>().settings.lock().unwrap().auto_update;
                    let hidden = auto && app
                        .get_webview_window("main")
                        .map(|w| !w.is_visible().unwrap_or(false))
                        .unwrap_or(true);
                    if hidden {
                        let ver = u.version.clone();
                        if u.download_and_install(|_, _| {}, || {}).await.is_ok() {
                            app.restart();
                        }
                        // не поставилось тихо — покажем кнопку «Обновить»
                        let _ = app.emit("update-available", ver);
                    } else {
                        let _ = app.emit("update-available", u.version);
                    }
                }
            }
            tokio_sleep(std::time::Duration::from_secs(900)).await;
        }
    });
}

async fn tokio_sleep(d: std::time::Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

#[tauri::command]
fn quit(app: AppHandle, webview: Webview) -> Res<()> {
    require(&webview, "main")?;
    app.exit(0);
    Ok(())
}

// ---------- команды окна форума ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Hello {
    crawling: bool,
    done: bool,
    left: usize,
    saved: usize,
    has_this: bool,
    kind: Option<String>,
}

#[tauri::command]
fn forum_hello(webview: Webview, state: State<AppState>, url: String) -> Res<Hello> {
    require(&webview, "forum")?;
    let lib = state.lib.lock().unwrap();
    let mut c = state.crawl.lock().unwrap();
    let done = std::mem::take(&mut c.done);
    Ok(Hello {
        crawling: c.active,
        done,
        left: c.queue.len(),
        saved: lib.docs.len(),
        has_this: thread_id(&url).is_some_and(|id| lib.docs.iter().any(|d| d.id == id)),
        kind: c.current.as_ref().filter(|_| c.active).map(|q| q.kind.clone()),
    })
}

#[derive(Deserialize)]
struct IncomingDoc {
    id: String,
    title: String,
    url: String,
    section: String,
    text: String,
}

#[tauri::command]
fn forum_save(app: AppHandle, webview: Webview, state: State<AppState>, doc: IncomingDoc) -> Res<Option<String>> {
    require(&webview, "forum")?;
    if !doc.url.starts_with(forum()) {
        return Err("Чужой адрес".into());
    }
    {
        let mut lib = state.lib.lock().unwrap();
        let t = now();
        if let Some(d) = lib.docs.iter_mut().find(|d| d.id == doc.id) {
            if d.text != doc.text {
                d.prev_text = Some(std::mem::take(&mut d.text));
                d.changed_at = Some(t);
            }
            d.text = doc.text;
            d.title = clean_title(&doc.title);
            d.section = doc.section;
            d.url = doc.url;
            d.fetched_at = t;
        } else {
            lib.docs.push(Doc {
                id: doc.id,
                title: clean_title(&doc.title),
                url: doc.url,
                section: doc.section,
                text: doc.text,
                prev_text: None,
                fetched_at: t,
                changed_at: None,
                base_at: None,
            });
        }
        save(&app, "library.json", &*lib)?;
    }
    let _ = app.emit("docs-updated", ());
    let mut c = state.crawl.lock().unwrap();
    if !c.active {
        return Ok(None);
    }
    c.saved_now += 1;
    Ok(next_url(&app, &mut c))
}

#[tauri::command]
fn forum_skip(app: AppHandle, webview: Webview, state: State<AppState>) -> Res<Option<String>> {
    require(&webview, "forum")?;
    let mut c = state.crawl.lock().unwrap();
    if !c.active {
        return Ok(None);
    }
    Ok(next_url(&app, &mut c))
}

#[tauri::command]
fn forum_queue(app: AppHandle, webview: Webview, state: State<AppState>, items: Vec<QItem>, start: bool) -> Res<Option<String>> {
    require(&webview, "forum")?;
    let mut c = state.crawl.lock().unwrap();
    if start {
        *c = Crawl { active: true, ..Default::default() };
    }
    if !c.active {
        return Ok(None);
    }
    // темы раздела идут раньше его подразделов и следующих страниц
    let mut threads = vec![];
    let mut sections = vec![];
    for it in items {
        if !it.url.starts_with(forum()) || c.seen.len() >= MAX_QUEUE {
            continue;
        }
        if c.seen.insert(queue_key(&it)) {
            if it.kind == "thread" { threads.push(it) } else { sections.push(it) }
        }
    }
    for it in threads.into_iter().rev() {
        c.queue.push_front(it);
    }
    c.queue.extend(sections);
    Ok(next_url(&app, &mut c))
}

#[tauri::command]
fn forum_stop(app: AppHandle, webview: Webview, state: State<AppState>) -> Res<()> {
    require(&webview, "forum")?;
    let mut c = state.crawl.lock().unwrap();
    c.active = false;
    c.queue.clear();
    emit_status(&app, &c);
    Ok(())
}

#[tauri::command]
fn forum_close(app: AppHandle, webview: Webview) -> Res<()> {
    require(&webview, "forum")?;
    if let Some(w) = app.get_webview_window("forum") {
        let _ = w.close();
    }
    show_main(&app);
    Ok(())
}

// ---------- запуск ----------

/// Установленная копия (её обновляет автообновление): %LOCALAPPDATA%\Trace Helper\Trace Helper.exe
#[cfg(windows)]
fn installed_exe() -> Option<std::path::PathBuf> {
    let p = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
        .join("Trace Helper")
        .join("Trace Helper.exe");
    p.is_file().then_some(p)
}

/// Запущена посторонняя копия exe (например, скопированная на рабочий стол или диск D),
/// а программа установлена — передаём запуск установленной версии. Иначе старая копия
/// стартует с Windows, а single-instance не даёт открыть новую.
#[cfg(windows)]
fn redirect_to_installed() -> bool {
    if cfg!(debug_assertions) || std::env::var_os("TH_NO_REDIRECT").is_some() {
        return false;
    }
    let (Ok(cur), Some(inst)) = (std::env::current_exe(), installed_exe()) else {
        return false;
    };
    match (std::fs::canonicalize(&cur), std::fs::canonicalize(&inst)) {
        (Ok(a), Ok(b)) if a != b => {}
        _ => return false,
    }
    std::process::Command::new(&inst)
        .args(std::env::args_os().skip(1))
        .env("TH_NO_REDIRECT", "1")
        .spawn()
        .is_ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    if redirect_to_installed() {
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, sc, ev| {
                    if ev.state() == ShortcutState::Pressed {
                        let voice = VOICE_ID.load(std::sync::atomic::Ordering::SeqCst);
                        if voice != 0 && sc.id() == voice {
                            voice_hotkey(app);
                        } else {
                            toggle_main(app);
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            // автозапуск хранит путь к exe, из которого его включили, и сам не обновляется:
            // переписываем на текущий exe, чтобы с Windows стартовала эта (свежая) версия
            if !cfg!(debug_assertions) {
                let al = handle.autolaunch();
                if al.is_enabled().unwrap_or(false) {
                    let _ = al.enable();
                }
            }
            let mut lib: Library = load(&handle, "library.json");
            for d in &mut lib.docs {
                d.title = clean_title(&d.title);
            }
            // база внутри программы: у нового пользователя правила и законы есть сразу
            if let Ok(base) = serde_json::from_str::<Library>(BASE_JSON) {
                if merge_base(&mut lib, base) {
                    let _ = save(&handle, "library.json", &lib);
                }
            }
            let mut settings: Settings = load(&handle, "settings.json");
            // 1.7.1: автообновление больше не включено по умолчанию — сбрасываем один раз у всех
            if settings.rev < 1 {
                settings.auto_update = false;
                settings.rev = 1;
                let _ = save(&handle, "settings.json", &settings);
            }
            // состояние — сразу, до создания окон: иначе окно успевает спросить настройки раньше и получает ошибку
            app.manage(AppState {
                lib: Mutex::new(lib),
                settings: Mutex::new(settings.clone()),
                crawl: Mutex::new(Crawl::default()),
            });
            if headless() {
            } else {
                if let Err(e) = register_hotkeys(&handle, &settings) {
                    eprintln!("hotkey: {e}");
                }
                if let Err(e) = make_voice_window(&handle) {
                    eprintln!("voice window: {e}");
                }
                if let Err(e) = make_history_window(&handle) {
                    eprintln!("history window: {e}");
                }
            }
            apply_window_settings(&handle, &settings);

            let open = MenuItem::with_id(app, "open", "Открыть (Alt+Q)", true, None::<&str>)?;
            let sync = MenuItem::with_id(app, "sync", "Обновить законы", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &sync, &quit])?;
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Trace Helper")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show_main(app),
                    "sync" => {
                        show_main(app);
                        let _ = app.emit("tray-sync", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        toggle_main(tray.app_handle());
                    }
                })
                .build(app)?;

            if !cfg!(debug_assertions) {
                spawn_update_checks(handle.clone());
            }
            spawn_base_sync(handle.clone());

            #[cfg(debug_assertions)]
            if forum() != FORUM_DEFAULT {
                let cap = format!(
                    r#"{{"identifier":"forum-dev","windows":["forum"],"remote":{{"urls":["{}*"]}},"permissions":["allow-forum-hello","allow-forum-save","allow-forum-skip","allow-forum-queue","allow-forum-stop","allow-forum-close"]}}"#,
                    forum()
                );
                app.add_capability(cap.as_str())?;
                if let Ok(start) = std::env::var("FH_AUTOCRAWL") {
                    let st = handle.state::<AppState>();
                    let mut c = st.crawl.lock().unwrap();
                    *c = Crawl { active: true, ..Default::default() };
                    c.queue.push_back(QItem { url: start.clone(), kind: "section".into() });
                    let first = next_url(&handle, &mut c).unwrap();
                    drop(c);
                    open_forum_window(&handle, &first)?;
                }
            }

            if !std::env::args().any(|a| a == "--hidden") && !headless() {
                show_main(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "history" {
                match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    // ушёл из истории в игру — прячем всё, как при уходе из хелпера
                    WindowEvent::Focused(false) => blur_check(window.app_handle()),
                    _ => {}
                }
                return;
            }
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::Moved(p) => {
                    if window.is_visible().unwrap_or(false) {
                        remember_pos(window.app_handle(), p.x, p.y);
                        // окно истории едет вместе с хелпером
                        let app = window.app_handle();
                        if app.get_webview_window("history").is_some_and(|h| h.is_visible().unwrap_or(false)) {
                            place_history(app);
                        }
                    }
                }
                // крестик прячет в трей, выход — через меню трея
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                    hide_history(window.app_handle());
                }
                // прятать при переходе в игру — только если включено в настройках и окно не закреплено
                WindowEvent::Focused(false) => blur_check(window.app_handle()),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_docs,
            delete_doc,
            clear_changes,
            get_settings,
            set_settings,
            set_autostart,
            open_forum,
            sync_all,
            fetch_laws,
            set_pinned,
            hide_main,
            set_expanded,
            check_update,
            install_update,
            voice_resize,
            voice_hide,
            voice_open,
            toggle_history,
            history_hide,
            history_open,
            quit,
            forum_hello,
            forum_save,
            forum_skip,
            forum_queue,
            forum_stop,
            forum_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert_eq!(thread_id("https://forum.trace-rp.com/threads/47/").as_deref(), Some("47"));
        assert_eq!(thread_id("https://forum.trace-rp.com/threads/ugolovnyi-kodeks.2065/page-2").as_deref(), Some("2065"));
        assert_eq!(thread_id("https://forum.trace-rp.com/forums/laws.5/"), None);
        assert_eq!(clean_title("ЗакрытоПравила форума"), "Правила форума");
        assert_eq!(clean_title("Закрыто Закреплено Уголовный кодекс"), "Уголовный кодекс");
    }
}
