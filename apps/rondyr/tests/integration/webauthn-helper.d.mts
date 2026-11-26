export interface VirtualPasskey {
  readonly credentialId: string;
  readonly credentialIdBytes: Uint8Array<ArrayBuffer>;
  readonly publicKeyCose: Uint8Array;
  readonly privateKey: CryptoKey;
  readonly rpId: string;
  readonly userHandle: string | null;
  counter: number;
}

export interface CreationOptionsLike {
  readonly challenge: string;
  readonly rp: { readonly id: string };
  readonly user: { readonly id: string };
}

export interface RequestOptionsLike {
  readonly challenge: string;
  readonly rpId: string;
}

export interface RegistrationOverrides {
  readonly origin?: string;
  readonly rpId?: string;
  readonly challenge?: string;
  readonly userPresent?: boolean;
  readonly counter?: number;
}

export interface AssertionOverrides {
  readonly origin?: string;
  readonly rpId?: string;
  readonly challenge?: string;
  readonly counter?: number;
  readonly tamperSignature?: boolean;
  readonly crossOrigin?: boolean;
}

export function registerVirtualPasskey(
  options: CreationOptionsLike,
  origin: string,
  overrides?: RegistrationOverrides,
): Promise<{
  readonly passkey: VirtualPasskey;
  readonly credential: {
    readonly id: string;
    readonly rawId: string;
    readonly type: "public-key";
    readonly response: {
      readonly clientDataJSON: string;
      readonly attestationObject: string;
      readonly transports: Array<string>;
    };
  };
}>;

export function assertVirtualPasskey(
  passkey: VirtualPasskey,
  options: RequestOptionsLike,
  origin: string,
  overrides?: AssertionOverrides,
): Promise<{
  readonly id: string;
  readonly rawId: string;
  readonly type: "public-key";
  readonly response: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly userHandle: string | null;
  };
}>;
