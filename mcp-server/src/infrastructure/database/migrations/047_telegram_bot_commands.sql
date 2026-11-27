-- 047 — comandos de los bots por conversación de Telegram (DGX-1921). EXPAND only.
-- telegram-sync los recoge del conector (GET /chats/:id/bot-commands) en su ciclo de
-- dialogs y reemplaza el conjunto de cada chat solo cuando cambia; dgx-messages solo
-- los lee, para el selector junto al compositor. Ninguna fila existente cambia.

CREATE TABLE IF NOT EXISTS telegram_bot_commands (
    conversation_id text NOT NULL,
    bot text NOT NULL,
    command text NOT NULL,
    description text NOT NULL DEFAULT '',
    synced_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, bot, command)
);
