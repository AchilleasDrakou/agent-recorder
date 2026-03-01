(() => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const dispatchClick = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const x = Math.floor(rect.left + rect.width / 2);
    const y = Math.floor(rect.top + rect.height / 2);
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
    const types = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    for (const type of types) {
      el.dispatchEvent(new MouseEvent(type, opts));
    }
    if (typeof el.click === "function") {
      el.click();
    }
    return true;
  };

  const clickViewport = (x, y) => {
    const target = document.elementFromPoint(x, y);
    if (!target) return false;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      target.dispatchEvent(new MouseEvent(type, opts));
    }
    if (typeof target.click === "function") {
      target.click();
    }
    return true;
  };

  const findByText = () => {
    const textNeedles = [/click to boot/i, /\bboot\b/i, /start/i];
    const nodes = Array.from(
      document.querySelectorAll(
        "button, a, [role='button'], [tabindex], div, span, p, h1, h2, h3, canvas"
      )
    );

    for (const el of nodes) {
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (!textNeedles.some((rx) => rx.test(text))) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
      return el;
    }
    return null;
  };

  (async () => {
    await delay(1200);

    const textTarget = findByText();
    if (textTarget) {
      dispatchClick(textTarget);
      console.log("[pelian-hero] clicked text target");
      return;
    }

    const centerX = Math.floor(window.innerWidth / 2);
    const centerY = Math.floor(window.innerHeight / 2);

    const points = [
      [centerX, centerY],
      [centerX, Math.floor(window.innerHeight * 0.62)],
      [centerX, Math.floor(window.innerHeight * 0.72)],
      [centerX, Math.floor(window.innerHeight * 0.52)],
    ];

    for (const [x, y] of points) {
      if (clickViewport(x, y)) {
        console.log(`[pelian-hero] clicked viewport point ${x},${y}`);
      }
      await delay(350);
    }
  })().catch((err) => {
    console.log(`[pelian-hero] script error: ${String(err)}`);
  });
})();
