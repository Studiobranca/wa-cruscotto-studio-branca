interface PriorityBadgeProps {
  priority: string;
  label?: string | null;
}

export default function PriorityBadge({ priority, label }: PriorityBadgeProps) {
  if (!priority || priority === 'none') return null;

  const classes: Record<string, string> = {
    vip: 'badge-vip',
    high: 'badge-high',
    normal: 'badge-normal',
  };

  const labels: Record<string, string> = {
    vip: 'VIP',
    high: 'Alta',
    normal: 'Normale',
  };

  return (
    <span className={`badge ${classes[priority] || 'badge-normal'}`}>
      {label || labels[priority] || priority}
    </span>
  );
}
