declare module "picomatch" {
  interface PicomatchOptions {
    dot?: boolean;
  }

  interface Picomatch {
    (glob: string, options?: PicomatchOptions): (input: string) => boolean;
    isMatch(input: string, glob: string, options?: PicomatchOptions): boolean;
  }

  const picomatch: Picomatch;
  export = picomatch;
}
