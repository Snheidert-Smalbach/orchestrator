import * as Dialog from "@radix-ui/react-dialog";
import { FolderSearch, LoaderCircle, ScanSearch, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { DetectedProject } from "../lib/types";

type Props = {
  open: boolean;
  busy: boolean;
  defaultRoot: string;
  detectedProjects: DetectedProject[];
  onOpenChange: (open: boolean) => void;
  onPickRoot: () => Promise<string | null>;
  onScan: (rootPath: string, recursive: boolean) => Promise<void>;
  onImport: (rootPath: string, recursive: boolean, selectedRootPaths?: string[]) => Promise<void>;
};

export function ScanDialog({ open, busy, defaultRoot, detectedProjects, onOpenChange, onPickRoot, onScan, onImport }: Props) {
  const [rootPath, setRootPath] = useState(defaultRoot);
  const [recursive, setRecursive] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);

  useEffect(() => {
    setRootPath(defaultRoot);
  }, [defaultRoot]);

  useEffect(() => {
    setSelectedPaths(detectedProjects.filter((project) => !project.alreadyImported).map((project) => project.rootPath));
  }, [detectedProjects]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/62 backdrop-blur-sm" />
        <Dialog.Content className="surface-panel fixed left-1/2 top-1/2 max-h-[85vh] w-[min(980px,92vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden">
          <div className="surface-divider flex items-center justify-between px-6 py-5">
            <div>
              <Dialog.Title className="text-xl font-semibold text-textStrong">Escanear repositorios de backend</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-textMuted">Detecta proyectos, scripts y puertos base para importarlos al catalogo.</Dialog.Description>
            </div>
            <Dialog.Close className="surface-chip p-2 text-textStrong transition hover:bg-panelSoft"><X className="h-4 w-4" /></Dialog.Close>
          </div>

          <div className="surface-divider grid gap-4 px-6 py-5 md:grid-cols-[1fr_auto_auto_auto]">
            <label className="space-y-2">
              <span className="text-xs uppercase tracking-[0.18em] text-textSoft">Root</span>
              <input className="surface-chip w-full px-4 py-3 text-textStrong" value={rootPath} onChange={(event) => setRootPath(event.target.value)} />
            </label>
            <button className="surface-chip mt-auto inline-flex items-center gap-2 px-4 py-3 text-sm font-semibold text-textStrong" onClick={async () => { const picked = await onPickRoot(); if (picked) setRootPath(picked); }}><FolderSearch className="h-4 w-4" /> Elegir</button>
            <label className="surface-chip mt-auto inline-flex items-center gap-2 px-4 py-3 text-sm text-textStrong"><input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} /> Recursivo</label>
            <button className="mt-auto inline-flex items-center justify-center gap-2 border border-accent/40 bg-accent/10 px-4 py-3 text-sm font-semibold text-accent" onClick={() => void onScan(rootPath, recursive)}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />} Escanear</button>
          </div>

          <div className="max-h-[420px] overflow-auto scrollbar-thin">
            <table className="min-w-full border-collapse text-sm">
              <thead className="sticky top-0 bg-panel">
                <tr className="border-b border-line text-left text-xs uppercase tracking-[0.18em] text-textSoft">
                  <th className="px-5 py-3">Importar</th>
                  <th className="px-5 py-3">Proyecto</th>
                  <th className="px-5 py-3">Comando sugerido</th>
                  <th className="px-5 py-3">Puerto</th>
                  <th className="px-5 py-3">Estado</th>
                </tr>
              </thead>
              <tbody>
                {detectedProjects.map((project) => {
                  const checked = selectedPaths.includes(project.rootPath);
                  return (
                    <tr key={project.rootPath} className="border-b border-line/70">
                      <td className="px-5 py-4"><input type="checkbox" checked={checked} disabled={project.alreadyImported} onChange={(event) => setSelectedPaths((current) => event.target.checked ? [...current, project.rootPath] : current.filter((entry) => entry !== project.rootPath))} /></td>
                      <td className="px-5 py-4"><p className="font-semibold text-textStrong">{project.name}</p><p className="mt-1 text-xs text-textMuted">{project.rootPath}</p></td>
                      <td className="px-5 py-4 text-textStrong">{project.suggestedRunMode === "script" ? "script" : "command"} / {project.suggestedRunTarget}</td>
                      <td className="px-5 py-4 text-textStrong">{project.suggestedPort ?? "n/a"}</td>
                      <td className="px-5 py-4 text-textMuted">{project.alreadyImported ? "Ya importado" : "Nuevo"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="surface-divider-top flex flex-wrap items-center justify-between gap-3 px-6 py-5">
            <p className="text-sm text-textMuted">{detectedProjects.length ? `${selectedPaths.length} de ${detectedProjects.length} seleccionados` : "Aun no hay proyectos detectados."}</p>
            <button className="inline-flex items-center gap-2 border border-accent/40 bg-accent/10 px-4 py-3 text-sm font-semibold text-accent" onClick={() => void onImport(rootPath, recursive, selectedPaths)} disabled={!detectedProjects.length}><FolderSearch className="h-4 w-4" /> Importar seleccionados</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
