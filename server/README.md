# Сервер Trace Helper

Railway Function (Bun). Распознаёт голос (`/stt`), отвечает на вопросы по законам (`/ask`), пересылает отзывы в Telegram (`/feedback`).
Ключи берутся только из переменных окружения: `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `TG_BOT_TOKEN`, `TG_CHAT_ID`.
Лимиты на пользователя и на IP в день: `STT_PER_DAY`, `IP_PER_DAY`, `ASK_PER_DAY`, `FEEDBACK_PER_DAY`.
Записи голоса и вопросы не сохраняются: сервер передаёт их в API модели и возвращает ответ.
