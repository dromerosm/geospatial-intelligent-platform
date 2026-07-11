// Minimal ambient types for `omggif` (ships without its own declarations).
declare module "omggif" {
  export class GifReader {
    constructor(buf: Uint8Array);
    readonly width: number;
    readonly height: number;
    numFrames(): number;
    decodeAndBlitFrameRGBA(frameNum: number, pixels: Uint8Array): void;
  }
}
