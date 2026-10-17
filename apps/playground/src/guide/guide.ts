// The new-player guide: detect the device, open the matching tab, and check
// the things that silently break the app (insecure origin, missing APIs).

import QRCode from "qrcode";
import { GAMEPAD_MAP } from "../controllers/gamepad-map";
import "./guide.css";

type Platform = "desktop" | "mobile" | "quest";

interface Device {
  platform: Platform;
  label: string;
  ios: boolean;
}

function detect(): Device {
  const ua = navigator.userAgent;
  if (/OculusBrowser|Quest/i.test(ua)) return { platform: "quest", label: "a Meta Quest headset", ios: false };
  // iPadOS reports itself as a Mac; touch points give it away.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (ios) return { platform: "mobile", label: /iPad|Macintosh/.test(ua) ? "an iPad" : "an iPhone", ios };
  if (/Android/.test(ua)) return { platform: "mobile", label: /Mobile/.test(ua) ? "an Android phone" : "an Android tablet", ios };
  const touchOnly = matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;
  if (touchOnly) return { platform: "mobile", label: "a touch screen", ios };
  return { platform: "desktop", label: "a computer", ios };
}

const device = detect();
const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

// ---- tabs -----------------------------------------------------------------

const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

function select(platform: Platform, focus = false) {
  for (const tab of tabs) {
    const on = tab.dataset.platform === platform;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    document.getElementById(tab.getAttribute("aria-controls")!)!.hidden = !on;
    if (on && focus) tab.focus();
  }
}

tabs.forEach((tab, i) => {
  if (tab.dataset.platform === device.platform) tab.insertAdjacentHTML("beforeend", '<span class="you">you</span>');
  tab.addEventListener("click", () => select(tab.dataset.platform as Platform));
  tab.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    const next = tabs[(i + step + tabs.length) % tabs.length];
    select(next.dataset.platform as Platform, true);
  });
});
select(device.platform);

document.getElementById("detected")!.textContent = `Looks like you're on ${device.label}.`;
if (device.platform === "quest") {
  document.getElementById("enter-hint")!.textContent = "Point and pull the trigger to go in. Your first poke wakes the sound.";
} else if (device.platform === "mobile") {
  document.getElementById("enter-hint")!.textContent = "Your first tap wakes the sound. Headphones help.";
}
if (!device.ios) document.getElementById("ios-silent")?.classList.add("muted");

// ---- readiness checks -----------------------------------------------------

type Status = "ok" | "warn" | "fail" | "info";
const list = document.getElementById("checks")!;
const alerts = document.getElementById("alerts")!;

function check(status: Status, title: string, detail: string) {
  const li = document.createElement("li");
  li.className = status;
  li.innerHTML = `<b>${title}</b><span>${detail}</span>`;
  list.append(li);
  if (status === "fail") {
    const a = document.createElement("p");
    a.className = "alert";
    a.innerHTML = `<b>${title}.</b> ${detail}`;
    alerts.append(a);
  }
}

function webgl2() {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

if (isSecureContext) {
  check("ok", "Secure address", "Sound is allowed on this page.");
} else {
  check(
    "fail",
    "Sound can't start on this address",
    `Browsers only allow the audio engine on https pages (or localhost on the same machine). Open the <b>https://</b> link from <code>npm run tunnel</code> instead of <code>${location.host}</code>.`,
  );
}
check(
  "AudioWorkletNode" in window ? "ok" : "fail",
  "AudioWorkletNode" in window ? "Audio engine supported" : "Audio engine not supported",
  "AudioWorkletNode" in window ? "This browser can run the sound engine." : "Update your browser. The sound engine needs AudioWorklet.",
);
check(
  typeof WebAssembly === "object" ? "ok" : "fail",
  typeof WebAssembly === "object" ? "WebAssembly" : "No WebAssembly",
  typeof WebAssembly === "object" ? "The toys' physics and sound can run." : "Update your browser. The toys run on WebAssembly.",
);
check(
  webgl2() ? "ok" : "fail",
  webgl2() ? "3D graphics" : "No 3D graphics",
  webgl2() ? "WebGL 2 is available." : "WebGL 2 is off or unsupported. Try another browser, or turn on hardware acceleration.",
);
if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
  check("info", "Reduced motion is on", "Flashes and wobbles are toned down to match your setting.");
}
if (device.platform === "mobile" && "getBattery" in navigator) {
  (navigator as Navigator & { getBattery(): Promise<{ level: number; charging: boolean }> })
    .getBattery()
    .then((b) => {
      if (b.level < 0.2 && !b.charging) check("warn", "Battery is low", "Low battery can make the phone slow down, and the sound may stutter. Plug in if you can.");
    })
    .catch(() => {});
}

const xr = (navigator as Navigator & { xr?: { isSessionSupported(mode: string): Promise<boolean> } }).xr;
if (xr) {
  Promise.all([xr.isSessionSupported("immersive-vr"), xr.isSessionSupported("immersive-ar")])
    .then(([vr, ar]) => {
      if (vr || ar) {
        const modes = [vr && "VR", ar && "mixed reality"].filter(Boolean).join(" and ");
        check("info", `WebXR ${modes} available`, "This device can step inside once the XR phase lands. For now the playground opens as a window.");
      }
    })
    .catch(() => {});
}

// ---- share to another device ---------------------------------------------

const share = document.getElementById("share")!;
const qr = document.getElementById("qr") as HTMLImageElement;
if (isLocal) {
  document.getElementById("share-text")!.innerHTML =
    "This page is on <code>localhost</code>, which other devices can't reach. Run <code>npm run tunnel</code> and open the https link it prints. It shows a code you can scan from here.";
  qr.remove();
} else {
  QRCode.toDataURL(location.href, { margin: 1, width: 296, color: { dark: "#e8e9ffff", light: "#00000000" } })
    .then((url) => (qr.src = url))
    .catch(() => share.remove());
}

// ---- controllers (generated from the gamepad map, so it can't drift) -----

const padRows = document.querySelector("#pad-controls tbody");
if (padRows) {
  for (const b of GAMEPAD_MAP) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = b.control;
    if (b.ps) {
      const ps = document.createElement("span");
      ps.className = "ps";
      ps.textContent = ` [${b.ps}]`;
      th.append(ps);
    }
    const td = document.createElement("td");
    td.textContent = b.does;
    tr.append(th, td);
    padRows.append(tr);
  }
}
