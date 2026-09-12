import type { ManuMcpConfig } from "./config.js";
export interface CommandExecutionResult {
    readonly ok: true;
    readonly shell: "powershell" | "cmd";
    readonly command: string;
    readonly cwd: string;
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly timedOut: boolean;
    readonly cancelled: boolean;
    readonly durationMs: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly outputTruncated: boolean;
}
export interface ProcessInfo {
    readonly pid: number;
    readonly name: string;
    readonly session?: string;
    readonly memory?: string;
}
export interface ScreenInfo {
    readonly index: number;
    readonly name: string;
    readonly primary: boolean;
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}
export interface WindowInfo {
    readonly handle: number;
    readonly title: string;
    readonly pid: number;
    readonly active: boolean;
}
export interface ScreenCapture {
    readonly data: string;
    readonly mimeType: "image/png";
    readonly width: number;
    readonly height: number;
    readonly screen: number | "all" | "primary";
}
interface ExecutableResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number | null;
}
export declare class SystemControl {
    #private;
    constructor(config: ManuMcpConfig);
    executeCommand(args: {
        command: string;
        shell: "powershell" | "cmd";
        cwd: string;
        timeoutMs: number;
        signal?: AbortSignal;
    }): Promise<CommandExecutionResult>;
    launchApplication(args: {
        executable: string;
        arguments: readonly string[];
        cwd: string;
    }): Promise<{
        ok: true;
        pid: number | null;
        executable: string;
        arguments: readonly string[];
        cwd: string;
    }>;
    openItem(args: {
        target: string;
        signal?: AbortSignal;
    }): Promise<{
        ok: true;
        target: string;
        pid: number | null;
    }>;
    listProcesses(filter: string | undefined, maxEntries: number): Promise<{
        ok: true;
        processes: readonly ProcessInfo[];
        truncated: boolean;
    }>;
    terminateProcess(pid: number, force: boolean): Promise<{
        ok: true;
        pid: number;
        force: boolean;
        output: string;
    }>;
    listWindows(): Promise<{
        ok: true;
        windows: readonly WindowInfo[];
    }>;
    focusWindow(handle: number): Promise<{
        ok: true;
        handle: number;
    }>;
    closeWindow(handle: number): Promise<{
        ok: true;
        handle: number;
    }>;
    getScreenInfo(): Promise<{
        ok: true;
        screens: readonly ScreenInfo[];
    }>;
    captureScreen(screenIndex: number | undefined, allScreens: boolean): Promise<ScreenCapture>;
    getCursorPosition(): Promise<{
        ok: true;
        x: number;
        y: number;
    }>;
    controlMouse(args: {
        action: "move" | "click" | "scroll";
        x?: number;
        y?: number;
        button?: "left" | "right" | "middle";
        clicks?: number;
        delta?: number;
    }): Promise<{
        ok: true;
        action: string;
        position: {
            x: number;
            y: number;
        };
    }>;
    typeText(text: string): Promise<{
        ok: true;
        characters: number;
    }>;
    hotkey(keys: readonly number[]): Promise<{
        ok: true;
        keys: readonly number[];
    }>;
    runPowerShell(script: string, maxBuffer: number): Promise<ExecutableResult>;
    runExecutable(file: string, args: readonly string[], throwOnError?: boolean, maxBuffer?: number): Promise<ExecutableResult>;
}
export declare function keyCodeFromName(value: string): number;
export {};
