// Usage:
//   node qr.js                          -> uses PUBLIC_URL if set, else the best Wi-Fi address
//   node qr.js 192.168.0.139            -> use a specific address
//   node qr.js https://my-site.com      -> use any full link (tunnel or deployed site)
// The QR code always points to /scan, so every scan adds one visit.
const os = require("os");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 3000;

const lanAddresses = () => {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      const isV4 = i.family === "IPv4" || i.family === 4;
      if (isV4 && !i.internal && !i.address.startsWith("169.254.")) {
        found.push({ name, address: i.address });
      }
    }
  }
  return found;
};

const score = ({ name, address }) => {
  const n = name.toLowerCase();
  let s = 0;
  if (/wi-?fi|wlan|wireless/.test(n)) s += 3;
  if (/vethernet|vmware|virtualbox|wsl|hyper-v|docker|vpn|tap|tun/.test(n)) s -= 5;
  if (address.startsWith("192.168.")) s += 2;
  else if (address.startsWith("10.")) s += 1;
  return s;
};

const withScan = (base) => base.replace(/\/+$/, "").replace(/\/scan$/, "") + "/scan";

const candidates = lanAddresses().sort((a, b) => score(b) - score(a));

console.log("Addresses found on this computer:");
if (candidates.length === 0) console.log("  none - connect to Wi-Fi first");
candidates.forEach((c) => console.log(`  http://${c.address}:${PORT}   (${c.name})`));
console.log("");

let base;
const arg = process.argv[2];
if (arg && /^https?:\/\//i.test(arg)) {
  base = arg;
} else if (arg) {
  base = `http://${arg}:${PORT}`;
} else if (process.env.PUBLIC_URL) {
  base = process.env.PUBLIC_URL;
} else if (candidates.length > 0) {
  base = `http://${candidates[0].address}:${PORT}`;
} else {
  base = `http://localhost:${PORT}`;
}

const url = withScan(base);

QRCode.toFile("qr.png", url, { width: 600, margin: 2 })
  .then(() => QRCode.toString(url, { type: "terminal", small: true }))
  .then((art) => {
    console.log(art);
    console.log(`QR code points to: ${url}`);
    console.log("Saved as qr.png");
  })
  .catch((err) => console.error(err));