const BASE = import.meta.env.VITE_IMAGE_BASE ?? "/images";

export function imageUrl(file: string) {
  return `${BASE}/${encodeURIComponent(file)}`;
}
