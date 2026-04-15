import { Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  deleteProjectMock,
  getProjectMocks,
  saveProjectMock,
} from "../lib/tauri";
import type {
  MockHeader,
  MockKind,
  Project,
  ProjectMock,
  ProjectMockCollection,
} from "../lib/types";
import { useAppStore } from "../store/useAppStore";

type MockEditorState = {
  mock: ProjectMock;
  requestHeadersText: string;
  responseHeadersText: string;
  graphqlQuery: string;
  graphqlVariablesText: string;
  graphqlOperationName: string;
};

const DEFAULT_GRAPHQL_RESPONSE = JSON.stringify({ data: {} }, null, 2);
const DEFAULT_REST_RESPONSE = JSON.stringify({ ok: true }, null, 2);

function emptySummary(): ProjectMockCollection["summary"] {
  return {
    totalCount: 0,
    graphqlCount: 0,
    restCount: 0,
    manualCount: 0,
    capturedCount: 0,
    lastUpdatedAt: null,
    routes: [],
  };
}

function createMockId() {
  return `mock-${Math.random().toString(36).slice(2, 10)}`;
}

function createEmptyMock(kind: Extract<MockKind, "rest" | "graphql">): ProjectMock {
  const isGraphql = kind === "graphql";
  return {
    id: createMockId(),
    name: isGraphql ? "Nuevo mock GraphQL" : "Nuevo mock REST",
    source: "manual",
    kind,
    recordedAt: new Date().toISOString(),
    notes: null,
    requestMethod: isGraphql ? "POST" : "GET",
    requestPath: isGraphql ? "/graphql" : "/api/recurso",
    requestQuery: "",
    requestHeaders: [],
    requestContentType: "application/json",
    requestBody: isGraphql ? JSON.stringify({ query: "query Ping {\n  ping\n}", variables: {} }, null, 2) : "",
    responseStatusCode: 200,
    responseReasonPhrase: "OK",
    responseHeaders: [],
    responseContentType: "application/json",
    responseBody: isGraphql ? DEFAULT_GRAPHQL_RESPONSE : DEFAULT_REST_RESPONSE,
  };
}

function headersToText(headers: MockHeader[]) {
  return headers.map((header) => `${header.name}: ${header.value}`).join("\n");
}

function splitHeaderLine(line: string) {
  const separatorIndex = line.includes(":") ? line.indexOf(":") : line.indexOf("=");
  if (separatorIndex < 0) {
    return null;
  }

  return {
    name: line.slice(0, separatorIndex).trim(),
    value: line.slice(separatorIndex + 1).trim(),
  };
}

function textToHeaders(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = splitHeaderLine(line);
      if (!parsed?.name) {
        throw new Error(`Encabezado invalido: ${line}`);
      }

      return parsed satisfies MockHeader;
    });
}

function parseGraphqlBody(body: string) {
  try {
    const parsed = JSON.parse(body) as {
      query?: unknown;
      variables?: unknown;
      operationName?: unknown;
    };

    return {
      query: typeof parsed.query === "string" ? parsed.query : "",
      variablesText: JSON.stringify(parsed.variables ?? {}, null, 2),
      operationName: typeof parsed.operationName === "string" ? parsed.operationName : "",
    };
  } catch {
    return {
      query: body,
      variablesText: "{}",
      operationName: "",
    };
  }
}

function createEditorState(mock: ProjectMock): MockEditorState {
  const graphqlState = mock.kind === "graphql" ? parseGraphqlBody(mock.requestBody) : null;

  return {
    mock: {
      ...mock,
      requestHeaders: mock.requestHeaders ?? [],
      responseHeaders: mock.responseHeaders ?? [],
      requestContentType: mock.requestContentType ?? "application/json",
      responseContentType: mock.responseContentType ?? "application/json",
      notes: mock.notes ?? null,
    },
    requestHeadersText: headersToText(mock.requestHeaders ?? []),
    responseHeadersText: headersToText(mock.responseHeaders ?? []),
    graphqlQuery: graphqlState?.query ?? "",
    graphqlVariablesText: graphqlState?.variablesText ?? "{}",
    graphqlOperationName: graphqlState?.operationName ?? "",
  };
}

function formatTimestamp(value: string | null) {
  if (!value) {
    return "sin fecha";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("es-CO", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildMockFromEditor(editor: MockEditorState): ProjectMock {
  const requestHeaders = textToHeaders(editor.requestHeadersText);
  const responseHeaders = textToHeaders(editor.responseHeadersText);
  const mock = {
    ...editor.mock,
    requestHeaders,
    responseHeaders,
    requestMethod: editor.mock.requestMethod.toUpperCase(),
    requestPath: editor.mock.requestPath.trim() || "/",
    requestQuery: editor.mock.requestQuery.trim(),
    responseStatusCode: Number(editor.mock.responseStatusCode || 200),
    responseReasonPhrase: editor.mock.responseReasonPhrase.trim() || "OK",
    notes: editor.mock.notes?.trim() ? editor.mock.notes.trim() : null,
  } satisfies ProjectMock;

  if (mock.kind === "graphql") {
    if (!editor.graphqlQuery.trim()) {
      throw new Error("El mock GraphQL necesita una query.");
    }

    let variables: unknown = {};
    if (editor.graphqlVariablesText.trim()) {
      variables = JSON.parse(editor.graphqlVariablesText);
    }

    const bodyPayload: Record<string, unknown> = {
      query: editor.graphqlQuery,
      variables,
    };
    if (editor.graphqlOperationName.trim()) {
      bodyPayload.operationName = editor.graphqlOperationName.trim();
    }

    return {
      ...mock,
      requestMethod: "POST",
      requestContentType: mock.requestContentType || "application/json",
      responseContentType: mock.responseContentType || "application/json",
      requestBody: JSON.stringify(bodyPayload, null, 2),
    };
  }

  return mock;
}

export function ProjectMocksEditor({ project }: { project: Project }) {
  const patchProjectMockSummary = useAppStore((state) => state.patchProjectMockSummary);
  const [collection, setCollection] = useState<ProjectMockCollection>({
    summary: project.mockSummary,
    mocks: [],
  });
  const [editor, setEditor] = useState<MockEditorState | null>(null);
  const [selectedMockId, setSelectedMockId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshMocks(preferredMockId?: string | null) {
    setIsLoading(true);
    setError(null);

    try {
      const nextCollection = await getProjectMocks(project.id);
      setCollection(nextCollection);
      patchProjectMockSummary(project.id, nextCollection.summary);

      const nextSelectedMock =
        nextCollection.mocks.find((mock) => mock.id === preferredMockId) ??
        nextCollection.mocks[0] ??
        null;
      setSelectedMockId(nextSelectedMock?.id ?? null);
      setEditor(nextSelectedMock ? createEditorState(nextSelectedMock) : null);
    } catch (loadError) {
      setCollection({ summary: emptySummary(), mocks: [] });
      setEditor(null);
      setSelectedMockId(null);
      setError(loadError instanceof Error ? loadError.message : "No fue posible cargar los mocks.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    setCollection((current) => ({
      ...current,
      summary: project.mockSummary,
    }));
  }, [project.id, project.mockSummary]);

  useEffect(() => {
    void refreshMocks();
  }, [patchProjectMockSummary, project.id]);

  function selectMock(mock: ProjectMock) {
    setSelectedMockId(mock.id);
    setEditor(createEditorState(mock));
    setError(null);
  }

  function handleCreate(kind: Extract<MockKind, "rest" | "graphql">) {
    const mock = createEmptyMock(kind);
    setSelectedMockId(null);
    setEditor(createEditorState(mock));
    setError(null);
  }

  async function handleSave() {
    if (!editor) {
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const savedMock = buildMockFromEditor(editor);
      const nextCollection = await saveProjectMock(project.id, savedMock);
      setCollection(nextCollection);
      patchProjectMockSummary(project.id, nextCollection.summary);

      const persistedMock =
        nextCollection.mocks.find((mock) => mock.id === savedMock.id) ??
        nextCollection.mocks[0] ??
        null;
      setSelectedMockId(persistedMock?.id ?? null);
      setEditor(persistedMock ? createEditorState(persistedMock) : null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "No fue posible guardar el mock.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    if (!editor) {
      return;
    }

    if (!selectedMockId) {
      setEditor(null);
      return;
    }

    setIsDeleting(true);
    setError(null);
    try {
      const nextCollection = await deleteProjectMock(project.id, selectedMockId);
      setCollection(nextCollection);
      patchProjectMockSummary(project.id, nextCollection.summary);
      const nextSelectedMock = nextCollection.mocks[0] ?? null;
      setSelectedMockId(nextSelectedMock?.id ?? null);
      setEditor(nextSelectedMock ? createEditorState(nextSelectedMock) : null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "No fue posible eliminar el mock.");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <section className="space-y-2 [grid-column:1/-1]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Mocks del servicio</p>
          <p className="mt-1 text-[12px] text-textMuted">
            {collection.summary.totalCount} mock(s) | {collection.summary.graphqlCount} GraphQL | {collection.summary.restCount} REST
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="surface-chip inline-flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold text-textStrong"
            onClick={() => void refreshMocks(selectedMockId)}
            disabled={isLoading}
          >
            <RefreshCw className={["h-3.5 w-3.5", isLoading ? "animate-spin" : ""].join(" ")} />
            Recargar
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 border border-accent/40 bg-accent/10 px-2 py-1.5 text-[11px] font-semibold text-accent"
            onClick={() => handleCreate("rest")}
          >
            <Plus className="h-3.5 w-3.5" />
            Nuevo REST
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 border border-info/35 bg-info/10 px-2 py-1.5 text-[11px] font-semibold text-info"
            onClick={() => handleCreate("graphql")}
          >
            <Plus className="h-3.5 w-3.5" />
            Nuevo GraphQL
          </button>
        </div>
      </div>

      <div className="surface-panel-soft grid gap-3 p-3 xl:grid-cols-[minmax(240px,0.9fr)_minmax(0,1.6fr)]">
        <div className="space-y-2">
          <div className="grid gap-1.5">
            {collection.mocks.length ? collection.mocks.map((mock) => (
              <button
                key={mock.id}
                type="button"
                className={[
                  "border px-3 py-2 text-left transition",
                  selectedMockId === mock.id
                    ? "border-accent/40 bg-accent/10 text-textStrong"
                    : "surface-chip text-textMuted hover:bg-panelSoft/80",
                ].join(" ")}
                onClick={() => selectMock(mock)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] font-semibold text-textStrong">{mock.name}</span>
                  <span className="surface-chip shrink-0 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-textMuted">
                    {mock.kind}
                  </span>
                </div>
                <p className="mt-1 truncate text-[11px] text-textMuted">
                  {mock.requestMethod} {mock.requestPath}{mock.requestQuery ? `?${mock.requestQuery}` : ""}
                </p>
                <p className="mt-1 text-[10px] text-textSoft">
                  {mock.source === "manual" ? "manual" : "capturado"} | {formatTimestamp(mock.recordedAt)}
                </p>
              </button>
            )) : (
              <div className="surface-panel px-3 py-4 text-[12px] text-textMuted">
                Todavia no hay mocks configurados para este microservicio.
              </div>
            )}
          </div>

          {collection.summary.routes.length ? (
            <div className="surface-panel px-3 py-3 text-[11px] text-textMuted">
              <p className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Rutas detectadas</p>
              <p className="mt-2">{collection.summary.routes.join(" | ")}</p>
            </div>
          ) : null}
        </div>

        <div className="space-y-3">
          {editor ? (
            <>
              <div className="grid gap-2 md:grid-cols-2">
                <label className="space-y-1.5">
                  <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Nombre</span>
                  <input
                    className="surface-chip w-full px-3 py-2 text-[13px] text-textStrong"
                    value={editor.mock.name}
                    onChange={(event) => setEditor({ ...editor, mock: { ...editor.mock, name: event.target.value } })}
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Tipo</span>
                  <select
                    className="surface-chip w-full px-3 py-2 text-[13px] text-textStrong"
                    value={editor.mock.kind}
                    onChange={(event) => {
                      const nextKind = event.target.value as ProjectMock["kind"];
                      setEditor((current) => {
                        if (!current) {
                          return current;
                        }

                        const nextEditor = {
                          ...current,
                          mock: {
                            ...current.mock,
                            kind: nextKind,
                            requestMethod: nextKind === "graphql" ? "POST" : current.mock.requestMethod,
                            requestPath: nextKind === "graphql" && current.mock.requestPath === "/api/recurso"
                              ? "/graphql"
                              : current.mock.requestPath,
                            requestContentType: "application/json",
                            responseContentType: "application/json",
                          },
                        };

                        if (nextKind === "graphql" && !current.graphqlQuery.trim()) {
                          return {
                            ...nextEditor,
                            graphqlQuery: "query Ping {\n  ping\n}",
                            graphqlVariablesText: "{}",
                          };
                        }

                        return nextEditor;
                      });
                    }}
                  >
                    <option value="rest">rest</option>
                    <option value="graphql">graphql</option>
                    <option value="http_other">http_other</option>
                  </select>
                </label>
              </div>

              <div className="grid gap-2 md:grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)]">
                <label className="space-y-1.5">
                  <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Metodo</span>
                  <input
                    className="surface-chip w-full px-3 py-2 text-[13px] text-textStrong"
                    value={editor.mock.requestMethod}
                    onChange={(event) => setEditor({ ...editor, mock: { ...editor.mock, requestMethod: event.target.value.toUpperCase() } })}
                    disabled={editor.mock.kind === "graphql"}
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Path</span>
                  <input
                    className="surface-chip w-full px-3 py-2 text-[13px] text-textStrong"
                    value={editor.mock.requestPath}
                    onChange={(event) => setEditor({ ...editor, mock: { ...editor.mock, requestPath: event.target.value } })}
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Query string</span>
                  <input
                    className="surface-chip w-full px-3 py-2 text-[13px] text-textStrong"
                    value={editor.mock.requestQuery}
                    onChange={(event) => setEditor({ ...editor, mock: { ...editor.mock, requestQuery: event.target.value } })}
                  />
                </label>
              </div>

              {editor.mock.kind === "graphql" ? (
                <div className="grid gap-2 md:grid-cols-2">
                  <label className="space-y-1.5 md:col-span-2">
                    <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Query GraphQL</span>
                    <textarea
                      rows={7}
                      className="surface-chip w-full px-3 py-2 text-[13px] text-textStrong"
                      value={editor.graphqlQuery}
                      onChange={(event) => setEditor({ ...editor, graphqlQuery: event.target.value })}
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Variables JSON</span>
                    <textarea
                      rows={6}
                      className="surface-chip w-full px-3 py-2 text-[13px] text-textStrong"
                      value={editor.graphqlVariablesText}
                      onChange={(event) => setEditor({ ...editor, graphqlVariablesText: event.target.value })}
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Operation name</span>
                    <input
                      className="surface-chip w-full px-3 py-2 text-[13px] text-textStrong"
                      value={editor.graphqlOperationName}
                      onChange={(event) => setEditor({ ...editor, graphqlOperationName: event.target.value })}
                    />
                  </label>
                </div>
              ) : (
                <label className="space-y-1.5">
                  <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Body request</span>
                  <textarea
                    rows={6}
                    className="surface-chip w-full px-3 py-2 text-[13px] text-textStrong"
                    value={editor.mock.requestBody}
                    onChange={(event) => setEditor({ ...editor, mock: { ...editor.mock, requestBody: event.target.value } })}
                  />
                </label>
              )}

              <div className="grid gap-2 md:grid-cols-2">
                <label className="space-y-1.5">
                  <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Headers request</span>
                  <textarea
                    rows={5}
                    className="surface-chip w-full px-3 py-2 text-[13px] text-textStrong"
                    placeholder="Authorization: Bearer ...&#10;X-Tenant: demo"
                    value={editor.requestHeadersText}
                    onChange={(event) => setEditor({ ...editor, requestHeadersText: event.target.value })}
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Headers response</span>
                  <textarea
                    rows={5}
                    className="surface-chip w-full px-3 py-2 text-[13px] text-textStrong"
                    placeholder="Content-Type: application/json"
                    value={editor.responseHeadersText}
                    onChange={(event) => setEditor({ ...editor, responseHeadersText: event.target.value })}
                  />
                </label>
              </div>

              <div className="grid gap-2 md:grid-cols-[120px_1fr]">
                <label className="space-y-1.5">
                  <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">HTTP status</span>
                  <input
                    type="number"
                    className="surface-chip w-full px-3 py-2 text-[13px] text-textStrong"
                    value={editor.mock.responseStatusCode}
                    onChange={(event) => setEditor({ ...editor, mock: { ...editor.mock, responseStatusCode: Number(event.target.value || 200) } })}
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Reason phrase</span>
                  <input
                    className="surface-chip w-full px-3 py-2 text-[13px] text-textStrong"
                    value={editor.mock.responseReasonPhrase}
                    onChange={(event) => setEditor({ ...editor, mock: { ...editor.mock, responseReasonPhrase: event.target.value } })}
                  />
                </label>
              </div>

              <label className="space-y-1.5">
                <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Body response</span>
                <textarea
                  rows={7}
                  className="surface-chip w-full px-3 py-2 text-[13px] text-textStrong"
                  value={editor.mock.responseBody}
                  onChange={(event) => setEditor({ ...editor, mock: { ...editor.mock, responseBody: event.target.value } })}
                />
              </label>

              <label className="space-y-1.5">
                <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Notas</span>
                <textarea
                  rows={3}
                  className="surface-chip w-full px-3 py-2 text-[13px] text-textStrong"
                  value={editor.mock.notes ?? ""}
                  onChange={(event) => setEditor({ ...editor, mock: { ...editor.mock, notes: event.target.value } })}
                />
              </label>

              {error ? <p className="text-[11px] text-danger">{error}</p> : null}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] text-textSoft">
                  Fuente: {selectedMockId ? (editor.mock.source === "manual" ? "manual" : "capturado") : "nuevo"} | ultima marca {formatTimestamp(editor.mock.recordedAt)}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 border border-danger/40 bg-danger/12 px-3 py-2 text-xs font-semibold text-danger"
                    onClick={() => void handleDelete()}
                    disabled={isDeleting}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {selectedMockId ? "Eliminar" : "Descartar"}
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 border border-accent/40 bg-accent/10 px-3 py-2 text-xs font-semibold text-accent"
                    onClick={() => void handleSave()}
                    disabled={isSaving}
                  >
                    <Save className="h-3.5 w-3.5" />
                    {isSaving ? "Guardando..." : "Guardar mock"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="surface-panel flex min-h-[240px] items-center justify-center px-4 text-[12px] text-textMuted">
              Selecciona un mock existente o crea uno nuevo para configurar respuestas REST o GraphQL.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
