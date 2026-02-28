(() => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const setBadge = (text, bg = "#111827") => {
    let el = document.getElementById("agent-recorder-badge");
    if (!el) {
      el = document.createElement("div");
      el.id = "agent-recorder-badge";
      el.style.position = "fixed";
      el.style.left = "12px";
      el.style.bottom = "12px";
      el.style.zIndex = "2147483647";
      el.style.padding = "8px 10px";
      el.style.borderRadius = "8px";
      el.style.font = "600 12px/1.3 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
      el.style.color = "#fff";
      el.style.boxShadow = "0 2px 8px rgba(0,0,0,0.35)";
      document.documentElement.appendChild(el);
    }
    el.style.background = bg;
    el.textContent = text;
  };

  const keywordScore = (text) => {
    const t = (text || "").toLowerCase().trim();
    const keywords = [
      "book",
      "demo",
      "start",
      "contact",
      "talk",
      "get started",
      "request",
      "trial",
      "learn",
      "sign up",
    ];
    return keywords.reduce((score, kw) => score + (t.includes(kw) ? 1 : 0), 0);
  };

  const findClickableNearBottom = () => {
    const clickables = Array.from(document.querySelectorAll("button, a, [role='button']"));
    const viewportH = window.innerHeight || 0;
    const ranked = clickables
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top < viewportH &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          !el.hasAttribute("disabled");
        if (!visible) return null;
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        const distanceToBottom = Math.abs(viewportH - rect.bottom);
        return {
          el,
          text,
          score: keywordScore(text),
          distanceToBottom,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.distanceToBottom - b.distanceToBottom;
      });

    return ranked.length ? ranked[0] : null;
  };

  (async () => {
    setBadge("Agent script: starting", "#1f2937");
    await delay(600);
    window.scrollTo({ top: 0, behavior: "auto" });
    await delay(300);

    for (let i = 0; i < 120; i += 1) {
      const atBottom =
        window.scrollY + window.innerHeight >=
        Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - 4;
      if (atBottom) break;
      window.scrollBy({ top: Math.max(240, Math.floor(window.innerHeight * 0.9)), behavior: "smooth" });
      await delay(120);
    }

    await delay(700);
    setBadge("Agent script: bottom reached", "#1f2937");
    const target = findClickableNearBottom();
    if (target && target.el) {
      target.el.click();
      setBadge(`Clicked: ${target.text || "<no-text>"}`, "#14532d");
      console.log(`[pelian-script] clicked: "${target.text || "<no-text>"}"`);
    } else {
      setBadge("No bottom CTA found", "#7f1d1d");
      console.log("[pelian-script] no clickable element found near bottom");
    }
  })().catch((err) => console.log(`[pelian-script] error: ${String(err)}`));
})();
