const iconPaths = {
  "icon-star": '<polygon points="12 3 14.8 8.7 21 9.6 16.5 14 17.6 20.2 12 17.2 6.4 20.2 7.5 14 3 9.6 9.2 8.7 12 3" />',
  "icon-mini": '<rect x="4" y="6" width="16" height="12" rx="2" /><path d="M9 15h6" />',
  "icon-menu": '<path d="M5 7h14M5 12h14M5 17h14" />',
  "icon-minus": '<path d="M5 12h14" />',
  "icon-close": '<path d="M6 6l12 12M18 6 6 18" />',
  "icon-chevron": '<path d="m7 10 5 5 5-5" />',
  "icon-prev": '<path d="M19 5 9 12l10 7V5Z" /><path d="M7 5v14" />',
  "icon-play": '<path d="M8 5v14l11-7L8 5Z" />',
  "icon-pause": '<path d="M8 5v14M16 5v14" />',
  "icon-next": '<path d="m5 5 10 7-10 7V5Z" /><path d="M17 5v14" />',
  "icon-volume": '<path d="M4 10v4h4l5 4V6l-5 4H4Z" /><path d="M16 9a5 5 0 0 1 0 6" /><path d="M18.5 6.5a8 8 0 0 1 0 11" />',
  "icon-muted": '<path d="M4 10v4h4l5 4V6l-5 4H4Z" /><path d="m17 9 4 6M21 9l-4 6" />',
  "icon-edit": '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" /><path d="m14 7 3 3" />',
  "icon-delete": '<path d="M5 7h14M10 11v6M14 11v6M8 7l1-3h6l1 3M7 7l1 13h8l1-13" />',
};

export function hydrateIcons(root = document) {
  root.querySelectorAll(".ui-icon").forEach((icon) => {
    const iconClass = [...icon.classList].find((className) => iconPaths[className]);
    if (!iconClass) return;
    icon.innerHTML = svg(iconPaths[iconClass]);
  });
}

export function updateIcon(icon, iconClass) {
  if (!iconPaths[iconClass]) return;

  for (const className of Object.keys(iconPaths)) {
    icon.classList.toggle(className, className === iconClass);
  }
  icon.innerHTML = svg(iconPaths[iconClass]);
}

function svg(content) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${content}</svg>`;
}
