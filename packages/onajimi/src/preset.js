let lib = null;

export const setPresetLib = (value) => {
  lib = value;
};

const presetLib = () => {
  if (!lib) {
    throw new Error("ルール集の部品（count・regexp・presetRules）が渡されていない。入口で setPresetLib を呼ぶ。");
  }
  return lib;
};

export const presetCount = () => presetLib().count;
export const createTester = (pattern, plain) => presetLib().regexp.createTester(pattern, plain);
export const parseRegExpLiteral = (pattern) => presetLib().regexp.parseRegExpLiteral(pattern);
export const presetRules = (preset, userOptions) => presetLib().presetRules(preset, userOptions);
