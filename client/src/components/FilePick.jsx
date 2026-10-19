import { useState } from 'react';
import Field from './Field';

export default function FilePick({ label = 'File', required = false, onFile }) {
  const [name, setName] = useState('');

  return (
    <Field label={label} hint={name ? name : 'pdf, office, image, text, or zip. Under 8 MB.'}>
      <input
        className="file-input"
        type="file"
        required={required && !name}
        accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.png,.jpg,.jpeg,.txt,.md,.zip"
        onChange={(event) => {
          const file = event.target.files?.[0] || null;
          setName(file ? file.name : '');
          onFile(file);
        }}
      />
    </Field>
  );
}
