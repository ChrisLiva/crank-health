import { List } from './List.jsx'
import { Counter } from './Counter.jsx'

export function App({ items, onSave }) {
  return (
    <main>
      <List items={items} />
      <Counter onSave={onSave} />
    </main>
  )
}
