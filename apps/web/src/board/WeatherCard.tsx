import { Card } from "../components/Card.tsx";
import { number, text } from "../lib/format.ts";
import { useBoardWeather } from "./useBoardState.ts";
import styles from "./WeatherCard.module.css";

export function WeatherCard() {
  const weather = useBoardWeather();

  if (weather === null) {
    return (
      <Card>
        <div className={styles.content}>
          <p className={styles.detail}>No weather data</p>
        </div>
      </Card>
    );
  }

  const headline = `${number(weather["air_temperature"], 1)}°C air / ${number(weather["track_temperature"], 1)}°C track`;
  const detail = `Humidity ${number(weather["humidity"], 0)}% · Rainfall ${text(weather["rainfall"])}`;

  return (
    <Card>
      <div className={styles.content}>
        <p className={styles.headline}>{headline}</p>
        <p className={styles.detail}>{detail}</p>
      </div>
    </Card>
  );
}
