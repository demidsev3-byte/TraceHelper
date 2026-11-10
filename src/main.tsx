import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import VoiceCard from "./VoiceCard";
import HistoryWindow from "./HistoryWindow";

// одно приложение в трёх окнах: основное, карточка голоса в игре и история справа (стили приходят вместе с App)
const label = getCurrentWindow().label;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{label === "voice" ? <VoiceCard /> : label === "history" ? <HistoryWindow /> : <App />}</React.StrictMode>,
);
