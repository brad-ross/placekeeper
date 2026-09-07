export type HandlerIconName = "chrome" | "delete" | "git-fork" | "redo";

type HandlerIconNode = readonly [
  tag: "circle" | "path",
  attributes: Readonly<Record<string, string>>,
];

const ICON_NODES: Readonly<Record<HandlerIconName, readonly HandlerIconNode[]>> = {
  chrome: [["path", {
    d: "M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29zm13.342 2.166a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-5.344 9.257c.206.01.413.016.621.016 6.627 0 12-5.373 12-12 0-1.54-.29-3.011-.818-4.364zM12 16.364a4.364 4.364 0 1 1 0-8.728 4.364 4.364 0 0 1 0 8.728Z",
    fill: "currentColor",
    stroke: "none",
  }]],
  delete: [
    ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" }],
    ["path", { d: "M3 6h18" }],
    ["path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }],
    ["path", { d: "M10 10v8" }],
    ["path", { d: "M14 10v8" }],
  ],
  "git-fork": [
    ["circle", { cx: "12", cy: "18", r: "3" }],
    ["circle", { cx: "6", cy: "6", r: "3" }],
    ["circle", { cx: "18", cy: "6", r: "3" }],
    ["path", { d: "M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" }],
    ["path", { d: "M12 12v3" }],
  ],
  redo: [
    ["path", { d: "m15 14 5-5-5-5" }],
    ["path", { d: "M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13" }],
  ],
};

export type HandlerButtonTone = "primary" | "secondary" | "destructive";

export function setHandlerButtonContent(
  button: HTMLButtonElement,
  iconName: HandlerIconName,
  label: string,
  tone: HandlerButtonTone = "secondary",
): void {
  const icon = button.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.classList.add("handler-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  for (const [tag, attributes] of ICON_NODES[iconName]) {
    const node = button.ownerDocument.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    icon.append(node);
  }
  const text = button.ownerDocument.createElement("span");
  text.textContent = label;
  button.className = `handler-button${tone === "secondary" ? "" : ` handler-button--${tone}`}`;
  button.dataset.icon = iconName;
  button.replaceChildren(icon, text);
}

export function createHandlerButton(
  document: Document,
  options: {
    readonly label: string;
    readonly icon: HandlerIconName;
    readonly tone?: HandlerButtonTone;
    readonly choice?: "resume" | "discard" | "fork";
  },
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.title = options.label;
  if (options.choice !== undefined) button.dataset.recoveryChoice = options.choice;
  setHandlerButtonContent(button, options.icon, options.label, options.tone);
  return button;
}
