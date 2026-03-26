import { randomUUID } from "node:crypto";

let monitorInstanceId: string | null = null;
let monitorStartedAt: string | null = null;

export function beginMonitorInstance(): { monitor_instance_id: string; started_at: string } {
  monitorInstanceId = randomUUID();
  monitorStartedAt = new Date().toISOString();
  return { monitor_instance_id: monitorInstanceId, started_at: monitorStartedAt };
}

export function clearMonitorInstance(): void {
  monitorInstanceId = null;
  monitorStartedAt = null;
}

export function getMonitorInstanceSnapshot(): {
  monitor_instance_id: string | null;
  monitor_started_at: string | null;
} {
  return { monitor_instance_id: monitorInstanceId, monitor_started_at: monitorStartedAt };
}
