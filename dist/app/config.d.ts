import type { FileAccessConfig, Profile } from "../core/file-access-config.js";
export interface ManuMcpConfig {
    readonly name: "ManuMCP";
    readonly version: string;
    readonly mode: "http" | "stdio";
    readonly workspacePath: string;
    readonly workspaceAlias: "workspace";
    readonly downloadsPath: string;
    readonly downloadsAlias: "downloads";
    readonly pcPath: string;
    readonly pcAlias: "pc";
    readonly profile: Profile;
    readonly port: number;
    readonly operationTimeoutMs: number;
    readonly localToken?: string;
    readonly confirmationKey: Buffer;
    readonly access: FileAccessConfig;
}
export declare function loadConfig(mode: "http" | "stdio"): Promise<ManuMcpConfig>;
