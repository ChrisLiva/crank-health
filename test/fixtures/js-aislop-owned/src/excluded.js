export function quiet(fn) {
  try {
    fn();
  } catch (error) {}
}
