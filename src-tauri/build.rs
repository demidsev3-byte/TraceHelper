// Команды приложения объявляются здесь, чтобы окну форума можно было выдать доступ
// только к своим командам (capabilities/forum.json), а главному окну — к остальным.
const COMMANDS: &[&str] = &[
    "get_docs",
    "delete_doc",
    "clear_changes",
    "get_settings",
    "set_settings",
    "set_autostart",
    "open_forum",
    "sync_all",
    "fetch_laws",
    "hide_main",
    "set_pinned",
    "set_expanded",
    "quit",
    "check_update",
    "install_update",
    "voice_resize",
    "voice_hide",
    "voice_open",
    "toggle_history",
    "history_hide",
    "history_open",
    "forum_hello",
    "forum_save",
    "forum_skip",
    "forum_queue",
    "forum_stop",
    "forum_close",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri build");
}
