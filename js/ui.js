export function setupUI() { const toggleButton = document.getElementById("menu-toggle"); const header = document.getElementById("header");

if (!toggleButton || !header) return;

toggleButton.addEventListener("click", () => { const expanded = toggleButton.getAttribute("aria-expanded") === "true"; toggleButton.setAttribute("aria-expanded", (!expanded).toString()); header.classList.toggle("open"); toggleButton.innerHTML = expanded ? "&#9660;" : "&#9650;";}); }

