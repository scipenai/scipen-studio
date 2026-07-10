import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import zh from "./zh.json";

function defaultLanguage(): string {
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem("snaca_lang");
    if (stored && stored.length > 0) return stored;
  }
  if (typeof navigator !== "undefined" && navigator.language.startsWith("zh")) {
    return "zh";
  }
  return "en";
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  lng: defaultLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
