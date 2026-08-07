import { useState } from 'react'

export function Counter({ onSave }) {
  const [draft, setDraft] = useState('')

  function handleChange(event) {
    setDraft(event.target.value)
  }

  function handleSave() {
    onSave(draft)
  }

  return (
    <div>
      <input onChange={handleChange} />
      <button onClick={handleSave}>Save</button>
    </div>
  )
}
