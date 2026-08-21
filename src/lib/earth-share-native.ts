import { registerPlugin } from "@capacitor/core";

export interface EarthShareNativePlugin {
  isGoogleEarthInstalled(): Promise<{ installed: boolean }>;
  openGoogleEarth(): Promise<{ opened: boolean }>;
  openGoogleEarthStore(): Promise<{ opened: boolean }>;
  saveFileToFiles(options: {
    filename: string;
    content: string;
    title?: string;
  }): Promise<{ saved: boolean; urls?: string[]; filename?: string }>;
  shareKml(options: {
    filename: string;
    content: string;
    title?: string;
  }): Promise<{ activityType?: string }>;
  shareFile(options: {
    filename: string;
    content: string;
    title?: string;
  }): Promise<{ activityType?: string }>;
  pickWaypointFile(): Promise<{ filename: string; content: string }>;
}

// Una única instancia compartida evita registrar EarthShare dos veces.
export const EarthShareNative = registerPlugin<EarthShareNativePlugin>("EarthShare");
