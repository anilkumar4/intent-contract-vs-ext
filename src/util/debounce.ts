export function debounce<T extends (...args: never[]) => void>(callback: T, delayMs: number): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      callback(...args);
    }, delayMs);
  };
}
