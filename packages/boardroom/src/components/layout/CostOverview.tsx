import { useEffect, useState } from 'react';
import type { GetCostResponse } from '../../types/api';
import { getCost } from '../../api/rest';
import styles from './CostOverview.module.css';

export function CostOverview() {
  const [today, setToday] = useState<GetCostResponse | null>(null);
  const [week, setWeek] = useState<GetCostResponse | null>(null);
  const [month, setMonth] = useState<GetCostResponse | null>(null);

  useEffect(() => {
    void getCost('today').then(setToday);
    void getCost('week').then(setWeek);
    void getCost('month').then(setMonth);
  }, []);

  const loading = !today || !week || !month;

  return (
    <div className={styles.overview}>
      <div className={styles.title}>Cost Overview</div>
      {loading ? (
        <div className={styles.loading}>Loading...</div>
      ) : (
        <>
          <div className={styles.cards}>
            <div className={styles.card}>
              <div className={styles.cardLabel}>Today</div>
              <div className={styles.cardValue}>&euro;{today.total_eur.toFixed(2)}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>This Week</div>
              <div className={styles.cardValue}>&euro;{week.total_eur.toFixed(2)}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>This Month</div>
              <div className={styles.cardValue}>&euro;{month.total_eur.toFixed(2)}</div>
            </div>
          </div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {today.agents.map((a) => (
                <tr key={a.agent_id}>
                  <td>{a.agent_name}</td>
                  <td>&euro;{a.cost_eur.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
