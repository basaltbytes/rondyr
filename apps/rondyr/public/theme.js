// Sets the chosen theme before the first paint, so the page never shows the other
// one first. The policy of _headers refuses an inline script, hence this file.
// dashboard/src/lib/appearance.ts writes the choice.
try {
  var theme = window.localStorage.getItem("rondyr-theme");
  if (theme === "light" || theme === "dark") document.documentElement.classList.add(theme);
} catch {
  // Without storage the page follows the system.
}
