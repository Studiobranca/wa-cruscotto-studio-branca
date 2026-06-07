interface KPICardProps {
  title: string;
  value: number | string;
  subtitle?: string;
  color?: 'green' | 'blue' | 'orange' | 'red' | 'purple';
  icon?: React.ReactNode;
}

const colorMap = {
  green: 'kpi-green',
  blue: 'kpi-blue',
  orange: 'kpi-orange',
  red: 'kpi-red',
  purple: 'kpi-purple',
};

export default function KPICard({ title, value, subtitle, color = 'blue', icon }: KPICardProps) {
  return (
    <div className={`kpi-card ${colorMap[color]}`}>
      {icon && <div className="kpi-icon">{icon}</div>}
      <div className="kpi-value">{value.toLocaleString()}</div>
      <div className="kpi-title">{title}</div>
      {subtitle && <div className="kpi-subtitle">{subtitle}</div>}
    </div>
  );
}
