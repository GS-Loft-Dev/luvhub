"use client";

import { useEffect, useState } from "react";
import { sections, ui, type Lang } from "./content";
import { I, Logo } from "../ui";

export default function Tutorial() {
  const [lang, setLang] = useState<Lang>("en");

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("h2h-lang");
    } catch {
      // Storage unavailable: fall back to the browser language.
    }
    if (saved === "it" || saved === "en") setLang(saved);
    else if (navigator.language.toLowerCase().startsWith("it")) setLang("it");
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const choose = (l: Lang) => {
    setLang(l);
    try {
      localStorage.setItem("h2h-lang", l);
    } catch {
      // Not persisted; fine.
    }
  };

  const t = ui[lang];
  const list = sections[lang];

  return (
    <main className="tut-shell">
      <header className="tut-top">
        <Logo />
        <div className="head-actions">
          <div className="tabs" role="group" aria-label="Language">
            <button className={lang === "it" ? "on" : ""} aria-pressed={lang === "it"} onClick={() => choose("it")}>IT</button>
            <button className={lang === "en" ? "on" : ""} aria-pressed={lang === "en"} onClick={() => choose("en")}>EN</button>
          </div>
          <a className="btn green sm" href="/">{t.open}</a>
        </div>
      </header>

      <div className="tut-hero">
        <span className="tag"><I.bolt /> Docs</span>
        <h1>{t.title}</h1>
        <p>{t.intro}</p>
      </div>

      <div className="tut">
        <nav className="toc" aria-label={t.toc}>
          <span className="label">{t.toc}</span>
          <ol>
            {list.map((s) => (
              <li key={s.id}><a href={`#${s.id}`}>{s.title}</a></li>
            ))}
          </ol>
          <a className="btn green" href="/">{t.open}</a>
        </nav>

        <div className="tut-body">
          {list.map((s, i) => (
            <section key={s.id} id={s.id} className="section tut-section">
              <h2><span className="num">{String(i + 1).padStart(2, "0")}</span>{s.title}</h2>
              {s.body}
            </section>
          ))}
          <a className="btn ghost" href="/" style={{ justifySelf: "start" }}>{t.back}</a>
        </div>
      </div>
    </main>
  );
}
