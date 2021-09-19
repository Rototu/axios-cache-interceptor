import { AxiosResponse } from 'axios';
import {
  AxiosCacheInstance,
  CacheAxiosResponse,
  CacheProperties,
  CacheRequestConfig
} from '../axios/types';
import { CachedStorageValue } from '../storage/types';
import { checkPredicateObject } from '../util/cache-predicate';
import { updateCache } from '../util/update-cache';
import { AxiosInterceptor } from './types';

type CacheConfig = CacheRequestConfig & { cache?: Partial<CacheProperties> };

export class CacheResponseInterceptor implements AxiosInterceptor<CacheAxiosResponse> {
  constructor(readonly axios: AxiosCacheInstance) {}

  apply = (): void => {
    this.axios.interceptors.response.use(this.onFulfilled);
  };

  testCachePredicate = (response: AxiosResponse, { cache }: CacheConfig): boolean => {
    const cachePredicate = cache?.cachePredicate || this.axios.defaults.cache.cachePredicate;

    return (
      (typeof cachePredicate === 'function' && cachePredicate(response)) ||
      (typeof cachePredicate === 'object' && checkPredicateObject(response, cachePredicate))
    );
  };

  onFulfilled = async (response: CacheAxiosResponse): Promise<CacheAxiosResponse> => {
    // Ignore caching
    if (response.config.cache === false) {
      return response;
    }

    const key = this.axios.generateKey(response.config);
    const cache = await this.axios.storage.get(key);

    // Response shouldn't be cached or was already cached
    if (cache.state !== 'loading') {
      return response;
    }

    // Config told that this response should be cached.
    if (!this.testCachePredicate(response, response.config as CacheConfig)) {
      // Update the cache to empty to prevent infinite loading state
      await this.axios.storage.remove(key);
      return response;
    }

    let ttl = response.config.cache?.ttl || this.axios.defaults.cache.ttl;

    if (response.config.cache?.interpretHeader) {
      const expirationTime = this.axios.headerInterpreter(response.headers);

      // Cache should not be used
      if (expirationTime === false) {
        // Update the cache to empty to prevent infinite loading state
        await this.axios.storage.remove(key);
        return response;
      }

      ttl = expirationTime ? expirationTime : ttl;
    }

    const newCache: CachedStorageValue = {
      data: { body: response.data, headers: response.headers },
      state: 'cached',
      ttl: ttl,
      createdAt: Date.now()
    };

    // Update other entries before updating himself
    if (response.config.cache?.update) {
      updateCache(this.axios, response.data, response.config.cache.update);
    }

    const deferred = this.axios.waiting[key];

    // Resolve all other requests waiting for this response
    if (deferred) {
      await deferred.resolve(newCache.data);
    }

    await this.axios.storage.set(key, newCache);

    return response;
  };
}
