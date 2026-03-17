import styles from './Badge.module.css';

interface BadgeProps {
  count: number;
}

export function Badge({ count }: BadgeProps) {
  if (count <= 0) return null;
  return <span className={styles.badge}>{count}</span>;
}
