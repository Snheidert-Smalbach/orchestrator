import { FolderPlus, FolderSearch, LoaderCircle, ScanSearch } from "lucide-react";
import { useEffect, useState } from "react";
import type { DetectedProject } from "../lib/types";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { DialogShell } from "./ui/dialog-shell";
import { EmptyState } from "./ui/empty-state";
import { FieldHint, FieldLabel, FieldLabelWrap } from "./ui/field";
import { Input } from "./ui/input";

type Props = {
  open: boolean;
  busy: boolean;
  defaultRoot: string;
  detectedProjects: DetectedProject[];
  onOpenChange: (open: boolean) => void;
  onPickRoot: (initialPath?: string) => Promise<string | null>;
  onScan: (rootPath: string, recursive: boolean) => Promise<void>;
  onImport: (rootPath: string, recursive: boolean, selectedRootPaths?: string[]) => Promise<void>;
  onImportSingle: (rootPath: string) => Promise<void>;
};

export function ScanDialog({
  open,
  busy,
  defaultRoot,
  detectedProjects,
  onOpenChange,
  onPickRoot,
  onScan,
  onImport,
  onImportSingle,
}: Props) {
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
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Escanear proyectos locales"
      description="Detecta la carpeta seleccionada y también sus subcarpetas inmediatas para importarlas al catálogo."
      widthClassName="w-[min(980px,92vw)]"
      bodyClassName="max-h-[84vh] overflow-auto"
    >
      <div className="grid gap-4 md:grid-cols-[1fr_auto_auto_auto]">
        <FieldLabelWrap>
          <FieldLabel>Root</FieldLabel>
          <Input value={rootPath} onChange={(event) => setRootPath(event.target.value)} />
          <FieldHint>Usa una carpeta base para detectar servicios y preparar una importación en lote.</FieldHint>
        </FieldLabelWrap>

        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="mt-auto"
          onClick={async () => {
            const picked = await onPickRoot(rootPath);
            if (picked) {
              setRootPath(picked);
            }
          }}
        >
          <FolderSearch className="h-4 w-4" />
          Elegir
        </Button>

        <label className="ui-inline-option mt-auto">
          <Checkbox checked={recursive} onChange={(event) => setRecursive(event.currentTarget.checked)} />
          <span>
            <span className="block text-[11px] font-semibold text-textStrong">Recursivo</span>
            <span className="block text-[10px] text-textMuted">Explora más profundidad del root.</span>
          </span>
        </label>

        <Button
          type="button"
          variant="default"
          size="lg"
          className="mt-auto"
          onClick={async () => {
            const picked = await onPickRoot(rootPath);
            if (picked) {
              setRootPath(picked);
              await onImportSingle(picked);
            }
          }}
        >
          <FolderPlus className="h-4 w-4" />
          Agregar uno
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-textMuted">
          {detectedProjects.length
            ? `${selectedPaths.length} de ${detectedProjects.length} candidatos listos para importar.`
            : "Aún no hay proyectos detectados."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => void onScan(rootPath, recursive)} busy={busy}>
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
            Escanear
          </Button>
          <Button
            type="button"
            variant="success"
            size="sm"
            onClick={() => void onImport(rootPath, recursive, selectedPaths)}
            disabled={!detectedProjects.length}
          >
            <FolderSearch className="h-4 w-4" />
            Importar seleccionados
          </Button>
        </div>
      </div>

      <div className="mt-4 max-h-[420px] overflow-auto scrollbar-thin pr-1">
        {detectedProjects.length ? (
          <div className="grid gap-2">
            {detectedProjects.map((project) => {
              const checked = selectedPaths.includes(project.rootPath);
              return (
                <Card key={project.rootPath} tone={project.alreadyImported ? "muted" : "default"} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-[13px] font-semibold text-textStrong">{project.name}</p>
                        <span className="ui-badge ui-badge--secondary">
                          {project.suggestedRunMode === "script" ? "script" : "command"}
                        </span>
                        <span className="ui-badge ui-badge--info">{project.packageManager}</span>
                        <span className="ui-badge ui-badge--secondary">
                          {project.alreadyImported ? "ya importado" : "nuevo"}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-textMuted">{project.rootPath}</p>
                      <div className="mt-3 grid gap-2 md:grid-cols-3">
                        <div>
                          <p className="text-[9px] uppercase tracking-[0.14em] text-textSoft">Comando sugerido</p>
                          <p className="mt-1 text-[11px] text-textStrong">
                            {project.suggestedRunMode === "script" ? "script" : "command"} / {project.suggestedRunTarget}
                          </p>
                        </div>
                        <div>
                          <p className="text-[9px] uppercase tracking-[0.14em] text-textSoft">Puerto</p>
                          <p className="mt-1 text-[11px] text-textStrong">{project.suggestedPort ?? "n/a"}</p>
                        </div>
                        <div>
                          <p className="text-[9px] uppercase tracking-[0.14em] text-textSoft">Estado</p>
                          <p className="mt-1 text-[11px] text-textStrong">{project.alreadyImported ? "Importado" : "Disponible"}</p>
                        </div>
                      </div>
                    </div>

                    <label className="ui-inline-option">
                      <Checkbox
                        checked={checked}
                        disabled={project.alreadyImported}
                        onChange={(event) =>
                          setSelectedPaths((current) =>
                            event.currentTarget.checked
                              ? [...current, project.rootPath]
                              : current.filter((entry) => entry !== project.rootPath),
                          )
                        }
                      />
                      <span>
                        <span className="block text-[11px] font-semibold text-textStrong">Importar</span>
                        <span className="block text-[10px] text-textMuted">
                          {project.alreadyImported ? "Ya está en el catálogo" : "Se incluirá en la importación"}
                        </span>
                      </span>
                    </label>
                  </div>
                </Card>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={<ScanSearch className="h-4 w-4" />}
            title="Todavía no hay resultados"
            description="Lanza un escaneo para ver proyectos detectados e importarlos al catálogo."
          />
        )}
      </div>
    </DialogShell>
  );
}
