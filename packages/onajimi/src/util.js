export const mapSeries = async (items, fn) => {
  const results = [];
  for (const item of items) {
    results.push(await fn(item));
  }
  return results;
};

export const memoize = (fn) => {
  const cache = new Map();
  return (key) => {
    if (!cache.has(key)) {
      cache.set(key, fn(key));
    }
    return cache.get(key);
  };
};
