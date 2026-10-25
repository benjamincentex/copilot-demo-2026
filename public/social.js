// CenTex Homeschool Hub social pages. Paste each page's full link here; an icon only shows once its link is set.
const SOCIAL = {
  facebook: "",
  instagram: "",
};
(function () {
  const ICONS = {
    facebook: { label: "Facebook", svg: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M13.3 19v-6h2l.3-2.4h-2.3V9.1c0-.7.2-1.2 1.2-1.2h1.2V5.8c-.2 0-1-.1-1.8-.1-1.8 0-3 1.1-3 3.1v1.8H8.9V13h2v6z" fill="var(--bg,#fff)"/></svg>' },
    instagram: { label: "Instagram", svg: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r="1.1" fill="currentColor" stroke="none"/></svg>' },
  };
  const html = Object.keys(ICONS).filter((k) => SOCIAL[k]).map((k) =>
    `<a href="${SOCIAL[k]}" target="_blank" rel="noopener" aria-label="CenTex Homeschool Hub on ${ICONS[k].label}" title="${ICONS[k].label}" style="color:var(--oak,#2F5A3D);display:inline-flex;padding:4px">${ICONS[k].svg}</a>`).join("");
  document.querySelectorAll("[data-social]").forEach((el) => {
    if (!html) { el.hidden = true; return; }
    el.innerHTML = `<span style="color:var(--muted,#76675A);font-size:14px">Follow us</span>${html}`;
    el.style.cssText = "display:flex;align-items:center;gap:6px";
  });
})();
