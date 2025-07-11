import { Injectable, Logger } from '@nestjs/common';
import {
  ErgastDriverStandingsResponse,
  ErgastRaceResultsResponse,
  ErgastRace,
  ErgastDriverStanding,
  ErgastStandingList,
} from './ergast.interface';
import { HttpClientService } from '../http.client/http.client.service';
import { ErgastEndpoints } from './ergast.endpoints';

@Injectable()
export class ErgastService {
  private readonly logger = new Logger(ErgastService.name);
  private readonly CONCURRENCY_LIMIT = 3; // Process 3 years at a time

  constructor(private readonly httpClient: HttpClientService) {
    this.httpClient.setRetryConfig({
      maxRetries: 3,
      retryOnStatus: [429, 500],
    });
  }

  async fetchDriverStandings(
    year: number,
    position?: number,
  ): Promise<ErgastDriverStanding[]> {
    const url = ErgastEndpoints.driverStandings(year);

    this.logger.log(
      `[Driver Standings] Fetching data for year ${year}${
        position ? ` (position ${position})` : ''
      }`,
    );

    const response =
      await this.httpClient.makeRequest<ErgastDriverStandingsResponse>({
        url,
        method: 'GET',
        context: 'F1 seasons (driverStanding)',
      });

    const data = response?.MRData.StandingsTable.StandingsLists ?? [];
    if (data.length === 0) {
      this.logger.warn(
        `[Driver Standings] No data found for year ${year}${
          position ? ` (position ${position})` : ''
        }`,
      );
      return [];
    }

    const champions = position
      ? this.filterStandingListBasedOnPosition(data, position)
      : this.transformStandingListToDriverStanding(data);

    this.logger.log(
      `[Driver Standings] Successfully fetched ${champions.length} records for year ${year}${
        position ? ` (position ${position})` : ''
      }`,
    );

    return champions;
  }

  async fetchSeasonChampions({
    fromYear,
    toYear,
    positionToFilterResults,
  }: {
    fromYear: number;
    toYear: number;
    positionToFilterResults?: number;
  }): Promise<ErgastDriverStanding[]> {
    this.logger.log(
      `[Season Champions] Fetching data from ${fromYear} to ${toYear}${
        positionToFilterResults ? ` (position ${positionToFilterResults})` : ''
      }`,
    );

    try {
      const years = Array.from(
        { length: toYear - fromYear + 1 },
        (_, index) => fromYear + index,
      );

      let results: ErgastDriverStanding[] = [];

      // Process years in batches
      for (let i = 0; i < years.length; i += this.CONCURRENCY_LIMIT) {
        const batch = years.slice(i, i + this.CONCURRENCY_LIMIT);
        const batchPromises = batch.map((year) =>
          this.fetchDriverStandings(year, positionToFilterResults).catch(
            (error) => {
              const errorMessage =
                error instanceof Error ? error.message : 'Unknown error';
              this.logger.error(
                `[Season Champions] Failed to fetch data for year ${year}: ${errorMessage}`,
              );
              return [];
            },
          ),
        );

        const batchResults = await Promise.all(batchPromises);
        results = results.concat(batchResults.flat());

        // Add a small delay between batches to avoid overwhelming the API
        if (i + this.CONCURRENCY_LIMIT < years.length) {
          await this.httpClient.delay(100);
        }
      }

      this.logger.log(
        `[Season Champions] Successfully fetched ${results.length} records from ${fromYear} to ${toYear}${
          positionToFilterResults
            ? ` (position ${positionToFilterResults})`
            : ''
        }`,
      );

      return results;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        `[Season Champions] Failed to fetch complete data: ${errorMessage}`,
      );
      throw new Error(`Failed to fetch complete data: ${errorMessage}`);
    }
  }

  async fetchSeasonRaces({
    year,
    positionToFilterResult,
  }: {
    year: number;
    positionToFilterResult?: number;
  }): Promise<ErgastRace[]> {
    let allRaces: ErgastRace[] = [];
    let offset = 0;
    const limit = 100;
    let total = 0;

    this.logger.log(
      `[Season Races] Fetching data for year ${year}${
        positionToFilterResult ? ` (position ${positionToFilterResult})` : ''
      }`,
    );

    do {
      const url = ErgastEndpoints.results({ year, limit, offset });

      this.logger.log(`Fetching races: offset=${offset}, limit=${limit}`);

      const response =
        await this.httpClient.makeRequest<ErgastRaceResultsResponse>({
          url,
          method: 'GET',
          context: 'F1 seasons (race results)',
        });
      const races = response?.MRData?.RaceTable?.Races || [];
      total = parseInt(response?.MRData?.total || '0');

      if (positionToFilterResult) {
        const filteredRaces = this.filterRaceResultsBasedOnPosition(
          races,
          positionToFilterResult,
        );
        this.logger.log(
          `[Season Races] Filtered ${filteredRaces.length} races for position ${positionToFilterResult} in year ${year}`,
        );
        allRaces = allRaces.concat(filteredRaces);
      } else {
        allRaces = allRaces.concat(races);
      }
      offset += limit;

      // Add delay between requests to respect rate limits
      if (offset < total) {
        await this.httpClient.delay(200);
      }
    } while (offset < total && total > 0);

    this.logger.log(
      `[Season Races] Successfully fetched ${allRaces.length} races for year ${year}`,
    );
    return allRaces;
  }

  private transformStandingListToDriverStanding(
    standingList: ErgastStandingList[],
  ): ErgastDriverStanding[] {
    const result: ErgastDriverStanding[] = [];
    for (const standing of standingList) {
      for (const driverStanding of standing.DriverStandings) {
        result.push({
          ...driverStanding,
          season: standing.season,
          round: standing.round,
        });
      }
    }
    return result;
  }

  private filterStandingListBasedOnPosition(
    data: ErgastStandingList[],
    position: number,
  ): (ErgastDriverStanding & { season: string; round: string })[] {
    return data.reduce<
      (ErgastDriverStanding & { season: string; round: string })[]
    >((acc, seasonData) => {
      const champion = seasonData.DriverStandings.find(
        (standing) => standing.position === position.toString(),
      );

      if (champion) {
        acc.push({
          ...champion,
          season: seasonData.season,
          round: seasonData.round,
        });
      }

      return acc;
    }, []);
  }

  private filterRaceResultsBasedOnPosition(
    races: ErgastRace[],
    position: number,
  ): ErgastRace[] {
    return races.filter((race) =>
      race.Results.some((result) => result.position === position.toString()),
    );
  }
}
