import sharp from "sharp";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve("public/images/services");
const names = ["PBI1", "RCP2", "FPC3", "PAC4", "IF5", "GPC6"];

await mkdir(directory, { recursive: true });

for (const name of names) {
  const input = path.join(directory, name + ".png");
  const output = path.join(directory, name + ".webp");
  await access(input);
  await sharp(input, { failOn: "error" })
    .rotate()
    .resize({ width: 1440, withoutEnlargement: true })
    .webp({ quality: 82, effort: 5 })
    .toFile(output);
  console.log(`Optimized ${name}.png -> ${name}.webp`);
}
