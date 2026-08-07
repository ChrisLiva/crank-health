export function List({ items }) {
  return (
    <ul>
      {items.map((item, index) => (
        <li key={index}>{item.label}</li>
      ))}
    </ul>
  )
}
