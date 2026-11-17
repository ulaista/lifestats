// Tiny pub/sub so open dashboards refresh the moment new data lands (Server-Sent Events).
type Listener = (kind: string) => void;
const listeners = new Set<Listener>();
export function onUpdate(l: Listener) { listeners.add(l); return () => listeners.delete(l); }
export function notify(kind: string) { for (const l of listeners) l(kind); }
