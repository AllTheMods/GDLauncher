import { createStore, applyMiddleware, compose } from 'redux';
import thunk from 'redux-thunk';
import { createHashHistory } from 'history';
import { routerMiddleware, routerActions } from 'connected-react-router';
import { persistReducer, persistStore } from 'redux-persist';
import { createLogger } from 'redux-logger';
import createRootReducer from '../reducers';
import persistConfig from './persistConfig';
import { UPDATE_DOWNLOAD_PROGRESS } from '../reducers/actionTypes';

const history = createHashHistory();
const rootReducer = createRootReducer(history);

const persistedReducer = persistReducer(persistConfig, rootReducer)

const configureStore = (initialState) => {
  // Redux Configuration
  const middleware = [];
  const enhancers = [];

  // Thunk Middleware
  middleware.push(thunk);

  // Skip redux logs in console during the tests
  if (process.env.NODE_ENV !== 'test') {
    const logger = createLogger({
      // We need to hide the UPDATE_PROGRESS dispatches, since they are just too many and they slow down the execution
      predicate: (getState, action) => action.type !== UPDATE_DOWNLOAD_PROGRESS,
      collapsed: true,
      duration: true,
      colors: {
        title: () => '#8e44ad',
        prevState: () => '#9E9E9E',
        action: () => '#03A9F4',
        nextState: () => '#4CAF50',
        error: () => '#F20404'
      }
    });
    middleware.push(logger);
  }

  // Router Middleware
  const router = routerMiddleware(history);
  middleware.push(router);

  // Redux DevTools Configuration
  const actionCreators = {
    ...routerActions
  };
  // If Redux DevTools Extension is installed use it, otherwise use Redux compose
  /* eslint-disable no-underscore-dangle */
  const composeEnhancers = window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__
    ? window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__({
      // Options: http://zalmoxisus.github.io/redux-devtools-extension/API/Arguments.html
      actionCreators
    })
    : compose;
  /* eslint-enable no-underscore-dangle */

  // Apply Middleware & Compose Enhancers
  enhancers.push(applyMiddleware(...middleware));
  const enhancer = composeEnhancers(...enhancers);

  // Create Store
  const store = createStore(persistedReducer, initialState, enhancer);
  const persistor = persistStore(store);

  if (module.hot) {
    module.hot.accept(
      '../reducers',
      () => store.replaceReducer(require('../reducers')).default
    ); // eslint-disable-line global-require
  }

  return { store, persistor };
};

export default { configureStore, history };
