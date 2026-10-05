/* App wiring: language selects, key save. */
(function () {
  const langs = window.PROMPTER_CONFIG.languages;
  function fill(id, def) {
    const s = document.getElementById(id); if (!s) return;
    s.innerHTML = langs.map(([c, n]) => '<option value="' + c + '"' + (c === def ? " selected" : "") + '>' + n + "</option>").join("");
  }
  fill("tr-from", "auto"); fill("tr-to", "en");
  fill("vs-from", "auto"); fill("vs-to", "en");
  const keyInput = document.getElementById("api-key");
  keyInput.value = NVIDIA.getKey();
  document.getElementById("save-key").addEventListener("click", () => {
    NVIDIA.setKey(keyInput.value);
    alert(NVIDIA.usingProxy() ? "Proxy mode: key saved but proxy is used." : (NVIDIA.getKey() ? "Key saved in this browser only." : "Key cleared."));
  });
})();
