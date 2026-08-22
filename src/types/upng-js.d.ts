declare module "upng-js" {
  export interface UPNGImage {
    width: number;
    height: number;
    depth: number;
    ctype: number;
    frames: unknown[];
    tabs: Record<string, unknown>;
    data: Uint8Array;
  }
  export function decode(buffer: ArrayBuffer | Uint8Array): UPNGImage;
  export function toRGBA8(img: UPNGImage): ArrayBuffer[];
  const _default: {
    decode: typeof decode;
    toRGBA8: typeof toRGBA8;
  };
  export default _default;
}

