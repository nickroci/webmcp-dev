import type { RegisteredTool } from '../src/core/types';

export function renderFields(container: HTMLElement, tool: RegisteredTool, values?: Record<string, unknown>) {
  container.replaceChildren();
  const fields: Array<{ name: string; schema: Record<string, any>; control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement }> = [];
  for (const [name, value] of Object.entries(tool.inputSchema.properties ?? {})) {
    const schema = value as Record<string, any>;
    const required = tool.inputSchema.required?.includes(name);
    const label = document.createElement('label'); label.className = 'field';
    const title = document.createElement('span'); title.textContent = `${schema.title ?? name.replaceAll('_', ' ')}${required ? ' *' : ''}`;
    label.append(title);
    let control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const initial = values ? values[name] : tool.defaults && Object.hasOwn(tool.defaults, name) ? tool.defaults[name] : Object.hasOwn(schema, 'default') ? schema.default : schema['x-generate'] === 'uuid' ? crypto.randomUUID() : undefined;
    if (schema.enum || (schema.type === 'boolean' && !required && initial === undefined)) {
      control = document.createElement('select');
      if (!required && schema.default === undefined) control.append(new Option('Not set', ''));
      for (const option of schema.enum ?? [true, false]) control.append(new Option(String(option), JSON.stringify(option)));
    } else if (schema.type === 'boolean') {
      control = document.createElement('input'); control.type = 'checkbox'; label.classList.add('boolean');
    } else if (schema['x-multiline'] || !['string', 'number', 'integer'].includes(schema.type)) {
      control = document.createElement('textarea'); control.rows = 4;
    } else {
      control = document.createElement('input');
      control.type = ['number', 'integer'].includes(schema.type) ? 'number' : schema.format === 'uri' ? 'url' : 'text';
      if (control.type === 'number') {
        control.step = schema.type === 'integer' ? '1' : 'any';
        if (schema.minimum !== undefined) control.min = String(schema.minimum);
        if (schema.maximum !== undefined) control.max = String(schema.maximum);
      }
    }
    control.name = name;
    // An optional false boolean is meaningful; "required" on a checkbox means true only.
    control.required = !!required && schema.type !== 'boolean';
    if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
      if (schema.maxLength !== undefined) control.maxLength = schema.maxLength;
      if (schema.minLength !== undefined) control.minLength = schema.minLength;
    }
    if (control instanceof HTMLSelectElement) { if (initial !== undefined) control.value = JSON.stringify(initial); }
    else if (schema.type === 'boolean') (control as HTMLInputElement).checked = initial === true;
    else if (initial !== undefined) control.value = ['string', 'number', 'integer'].includes(schema.type) ? String(initial) : JSON.stringify(initial, null, 2);
    label.append(control);
    if (schema.description && schema.type !== 'boolean') { const hint = document.createElement('small'); hint.textContent = schema.description; label.append(hint); }
    container.append(label);
    fields.push({ name, schema, control });
  }
  return () => {
    const input: Record<string, unknown> = {};
    for (const { name, schema, control } of fields) {
      if (control instanceof HTMLInputElement && control.type === 'checkbox') { input[name] = control.checked; continue; }
      if (control.value === '') continue;
      if (control instanceof HTMLSelectElement) input[name] = JSON.parse(control.value);
      else if (['number', 'integer'].includes(schema.type)) input[name] = Number(control.value);
      else if (schema.type === 'string') input[name] = control.value;
      else input[name] = JSON.parse(control.value);
    }
    return input;
  };
}
