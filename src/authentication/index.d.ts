/// <reference types="node" />
import { KeyObject } from 'node:crypto';

export type ServerDeviceCodeResponse = {
  user_code: string;
  device_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
};

export type Cache = {
  reset(): Promise<void>;
  getCached(): Promise<Record<string, unknown>>;
  setCached(value: Record<string, unknown>): Promise<void>;
  setCachedPartial(value: Record<string, unknown>): Promise<void>;
};

export type CacheFactory = (options: { username: string; cacheName: string }) => Cache;

export type MicrosoftAuthFlowOptions = {
  authTitle?: string;
  deviceType?: string;
  deviceVersion?: string;
  flow: 'live' | 'sisu';
  forceRefresh?: boolean;
  titleId?: string;
};

export declare const Titles: {
  readonly MinecraftNintendoSwitch: string;
  readonly MinecraftPlaystation: string;
  readonly MinecraftAndroid: string;
  readonly MinecraftJava: string;
  readonly MinecraftIOS: string;
  readonly XboxAppIOS: string;
  readonly XboxGamepassIOS: string;
};

export declare const Endpoints: Record<string, string>;

export type GetMinecraftBedrockServicesResponse = {
  mcToken: string;
  validUntil: string;
  treatments: string[];
  treatmentContext: string;
  configurations: object;
};

export declare class Authflow {
  username: string;
  options: MicrosoftAuthFlowOptions;
  constructor(
    username?: string,
    cache?: string | CacheFactory,
    options?: MicrosoftAuthFlowOptions,
    codeCallback?: (response: ServerDeviceCodeResponse) => void
  );
  getMsaToken(): Promise<string>;
  getXboxToken(relyingParty?: string, forceRefresh?: boolean): Promise<{
    userXUID: string;
    userHash: string;
    XSTSToken: string;
    expiresOn: string;
  }>;
  getMinecraftBedrockToken(publicKey: KeyObject | string, options?: { version?: string }): Promise<{
    chain: string[];
    token: string;
  }>;
  getMinecraftBedrockServicesToken(config: { version: string }): Promise<GetMinecraftBedrockServicesResponse>;
  getPlayfabLogin(): Promise<Record<string, unknown>>;
  getIdentityDiagnostics(): Record<string, unknown>;
}
