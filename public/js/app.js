const fileInputs = document.querySelectorAll("input[type='file']");

fileInputs.forEach((input) => {
  input.addEventListener("change", () => {
    const label = input.closest("label")?.querySelector("[data-file-label]");
    if (!label) return;
    const count = input.files?.length || 0;
    label.textContent = count
      ? `${count} file${count === 1 ? "" : "s"} selected`
      : "Works with single HTML, optimized HTML, ZIP, or an assets folder.";
  });
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((registration) => {
      registration.update().catch(() => {});
    }).catch(() => {});
  });
}
