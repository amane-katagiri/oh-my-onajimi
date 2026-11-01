import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { authorDir } from "./paths.js";
import { parseCorpusConfig } from "./corpus.js";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates/corpus.yml");

const EMPTY_PROFILE = "model_leaning: []\nauthor_leaning: []\northography: []\ndensity: []\nthresholds: {}\nallow: []\n";

export const starterCorpus = ({ posts } = {}) => {
  const text = fs.readFileSync(TEMPLATE, "utf8");
  const filled = posts === undefined ? text : text.replace(/^posts: .*$/mu, `posts: ${YAML.stringify(posts).trim()}`);
  parseCorpusConfig(filled);
  return filled;
};

export const initAuthor = ({ root, author, posts }) => {
  const dir = authorDir(root, author);
  const files = { "corpus.yml": starterCorpus({ posts }), "profile.yml": EMPTY_PROFILE };
  for (const name of Object.keys(files)) {
    if (fs.existsSync(path.join(dir, name))) {
      throw new Error(`${path.relative(process.cwd(), path.join(dir, name))} はもうある。作り直すなら消してから実行する。`);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  return Object.entries(files).map(([name, content]) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  });
};
