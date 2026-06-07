export default function Loader({ text = 'Caricamento...' }: { text?: string }) {
  return (
    <div className="loader-wrap">
      <div className="loader-spinner" />
      <p className="loader-text">{text}</p>
    </div>
  );
}
