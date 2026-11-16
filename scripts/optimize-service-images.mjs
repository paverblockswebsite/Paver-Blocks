import sharp from "sharp";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const outputDirectory = path.resolve("public/images/services");
const serviceNames = ["PBI1", "RCP2", "FPC3", "PAC4", "IF5", "GPC6"];
const sources = [
  ...serviceNames.map((name) => ({
    input: path.resolve(outputDirectory, name + ".png"),
    output: path.join(outputDirectory, name + ".webp"),
    label: name
  })),
  {
    input: path.resolve("PAVER BLOCKS — Labour Team.png"),
    output: path.join(outputDirectory, "labour-team.webp"),
    label: "Labour Team"
  }
];

await mkdir(outputDirectory, { recursive: true });

for (const source of sources) {
  await access(source.input);
  await sharp(source.input, { failOn: "error" })
    .rotate()
    .resize({ width: 1440, withoutEnlargement: true })
    .webp({ quality: 82, effort: 5 })
    .toFile(source.output);
  console.log(`Optimized ${source.label} image to WebP`);
}
