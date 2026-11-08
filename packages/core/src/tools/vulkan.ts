/**
 * Vulkan device detection for `recap doctor` (T23), via `vulkaninfo --summary`. It reports what the
 * OS exposes, not which device whisper.cpp will pick. Never throws.
 */
import { execFile } from 'node:child_process';
import { findOnPath } from '../audio/locate.ts';

export interface VulkanDevice {
  readonly name: string;
  /** `discrete GPU`, `integrated GPU`, `CPU`, ... */
  readonly type: string;
}

export type VulkanStatus =
  | { readonly state: 'found'; readonly devices: readonly VulkanDevice[] }
  /** vulkaninfo ran and listed no GPU. */
  | { readonly state: 'no-gpu'; readonly devices: readonly VulkanDevice[] }
  /** vulkaninfo is not installed or failed; nothing is known. */
  | { readonly state: 'unknown'; readonly reason: string };

export type VulkanProbe = () => Promise<VulkanStatus>;

const TIMEOUT_MS = 10_000;

function deviceType(raw: string): string {
  return raw
    .replace(/^PHYSICAL_DEVICE_TYPE_/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace('gpu', 'GPU')
    .replace('cpu', 'CPU');
}

/** Parses `vulkaninfo --summary` output. `deviceType` precedes `deviceName` in each GPU block. */
export function parseVulkanSummary(output: string): VulkanDevice[] {
  const devices: VulkanDevice[] = [];
  let type = 'unknown type';
  for (const line of output.split(/\r?\n/)) {
    const typeMatch = /^\s*deviceType\s*=\s*(\S+)/.exec(line);
    if (typeMatch?.[1] !== undefined) type = deviceType(typeMatch[1]);
    const nameMatch = /^\s*deviceName\s*=\s*(.+?)\s*$/.exec(line);
    if (nameMatch?.[1] !== undefined) {
      devices.push({ name: nameMatch[1], type });
      type = 'unknown type';
    }
  }
  return devices;
}

export function vulkanStatusFromOutput(output: string): VulkanStatus {
  const devices = parseVulkanSummary(output);
  return devices.some((d) => d.type.includes('GPU'))
    ? { state: 'found', devices }
    : { state: 'no-gpu', devices };
}

/** The default probe. The current directory is never searched for `vulkaninfo`. */
export const probeVulkan: VulkanProbe = async () => {
  const executable = await findOnPath('vulkaninfo', process.env, process.platform);
  if (executable === undefined) {
    return { state: 'unknown', reason: 'vulkaninfo not found on PATH' };
  }
  return new Promise<VulkanStatus>((resolve) => {
    execFile(
      executable,
      ['--summary'],
      { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        resolve(
          error === null
            ? vulkanStatusFromOutput(stdout)
            : { state: 'unknown', reason: 'vulkaninfo failed' },
        );
      },
    );
  });
};
