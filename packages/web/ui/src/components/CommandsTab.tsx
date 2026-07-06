import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { CommandTemplate } from "../types.js";

export function CommandsTab({ onChange }: { onChange: () => void }) {
  const [commands, setCommands] = useState<CommandTemplate[]>([]);
  const [selected, setSelected] = useState<CommandTemplate | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");

  const reload = async () => setCommands(await api.listCommands());
  useEffect(() => {
    void reload();
  }, []);

  const edit = (c: CommandTemplate) => {
    setSelected(c);
    setName(c.name);
    setBody(c.body);
  };
  const startNew = () => {
    setSelected(null);
    setName("");
    setBody("");
  };

  const save = async () => {
    if (selected) await api.renameCommand(selected.id, name, body);
    else await api.upsertCommand(name, body);
    await reload();
    onChange();
    startNew();
  };

  const remove = async (c: CommandTemplate) => {
    const res = await api.deleteCommand(c.id);
    if (res.referencedBy.length) {
      alert(`Deleted. Was referenced by: ${res.referencedBy.join(", ")}`);
    }
    await reload();
    onChange();
    if (selected?.id === c.id) startNew();
  };

  const derivedId = name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return (
    <div className="commands-tab">
      <div className="commands-list">
        <button className="primary" onClick={startNew}>
          + New template
        </button>
        <ul>
          {commands.map((c) => (
            <li key={c.id} className={selected?.id === c.id ? "active" : ""}>
              <button onClick={() => edit(c)}>{c.name}</button>
              <code>{c.id}</code>
              <button className="danger" onClick={() => remove(c)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="command-editor">
        <label>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Secure Feature"
          />
        </label>
        <label>
          Id (auto-derived, read-only)
          <input value={selected?.id ?? derivedId} readOnly />
        </label>
        <label className="prompt-field">
          Instructions
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14} />
        </label>
        <button className="primary" onClick={save} disabled={!name}>
          {selected ? "Save changes" : "Create template"}
        </button>
      </div>
    </div>
  );
}
